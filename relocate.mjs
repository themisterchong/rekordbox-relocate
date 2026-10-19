#!/usr/bin/env node
/**
 * rekordbox-relocate: point a rekordbox / rbxport library (master.db) at new music folders.
 *
 * Typical use: a library made on Windows (D:/MUSICDATA/Mp3/...) moved to Linux
 * (/home/me/music/MUSICDATA/...). Only path text changes, so cues, beat grids,
 * playlists, play counts and analysis all stay.
 *
 * Safety: the input file is only read. Changes go to a new file (--out), which is
 * checked after writing and deleted again if any check fails.
 */
import { existsSync, statSync, lstatSync, copyFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3-multiple-ciphers')

// Public key rekordbox 6/7 uses for master.db (same one pyrekordbox and rbxport use).
const DEFAULT_KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'

// Tables whose highest rb_local_usn the next change number must exceed, as rbxport's next_usn does.
const USN_TABLES = ['djmdContent', 'djmdPlaylist', 'djmdSongPlaylist', 'djmdSongHotCueBanklist']

// Columns that hold absolute file paths. Rows are only touched when they start with a --from folder.
const PATH_COLUMNS = [
  ['djmdContent', 'FolderPath'],
  ['djmdContent', 'OrgFolderPath'],
  ['djmdContent', 'rb_LocalFolderPath'],
  ['contentFile', 'rb_local_path'],
  ['imageFile', 'rb_local_path'],
  ['settingFile', 'rb_local_path'],
]

const HELP = `rekordbox-relocate: move a rekordbox / rbxport library to new music folders

Usage:
  node relocate.mjs <master.db>
      Show which folders your tracks are in. Changes nothing.

  node relocate.mjs <master.db> --from <old folder> --to <new folder> [--from ... --to ...]
      Dry run: show what would change and which files can't be found. Changes nothing.

  node relocate.mjs <master.db> --from <old> --to <new> --out <new master.db>
      Write the relocated library to a new file. The input is never changed.

Example (Windows library -> Linux):
  node relocate.mjs master.db --from 'D:\\MUSICDATA\\Mp3' --to /home/me/music/MUSICDATA --out master-linux.db

Options:
  --from / --to   Folder pair. Repeat for more pairs; the longest matching --from wins.
                  Windows paths match without regard to case or slash direction.
  --out <file>    Where to write the result. Without it, nothing is written.
  --no-check      Don't look for the files on this computer (e.g. when running on Windows
                  before the music is copied to the Linux machine).
  --force         Overwrite --out if it exists, and run even if the library looks open.
  --key <hex>     SQLCipher key, if your master.db uses a different one.
  --depth <n>     Folder depth for the overview (default 3).

Close rekordbox and rbxport before running, and keep a backup of master.db.`

// ---------- arguments ----------
function parseArgs(argv) {
  const o = { pairs: [], check: true, force: false, key: DEFAULT_KEY, depth: 3 }
  const from = [], to = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0) }
    else if (a === '--from') from.push(val())
    else if (a === '--to') to.push(val())
    else if (a === '--out') o.out = val()
    else if (a === '--key') o.key = val()
    else if (a === '--depth') o.depth = Math.max(1, parseInt(val(), 10) || 3)
    else if (a === '--no-check') o.check = false
    else if (a === '--force') o.force = true
    else if (a.startsWith('--')) fail(`unknown option ${a} (see --help)`)
    else if (!o.input) o.input = a
    else fail(`unexpected argument: ${a}`)
  }
  if (!o.input) { console.log(HELP); process.exit(1) }
  if (from.length !== to.length) fail('every --from needs a matching --to')
  o.pairs = from.map((f, i) => makePair(f, to[i]))
  if (o.out && !o.pairs.length) fail('--out needs at least one --from/--to pair')
  return o
}

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// ---------- paths ----------
const isWinPath = (p) => /^[A-Za-z]:([\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p)
const slashes = (p) => p.replace(/\\/g, '/')
const trimEnd = (p) => (p.length > 1 && !/^[A-Za-z]:\/$/.test(p) ? p.replace(/\/+$/, '') : p)

function makePair(from, to) {
  const f = trimEnd(slashes(from)), t = trimEnd(slashes(to))
  if (!f || !t) fail('--from and --to must not be empty')
  return { from: f, to: t, fromWin: isWinPath(from), toWin: isWinPath(to) }
}

/** New path for `p`, or null when no pair matches. */
function mapPath(p, pairs) {
  if (!p) return null
  const s = slashes(p)
  let best = null
  for (const pr of pairs) {
    const head = s.slice(0, pr.from.length)
    const same = pr.fromWin ? head.toLowerCase() === pr.from.toLowerCase() : head === pr.from
    const boundary = s.length === pr.from.length || s[pr.from.length] === '/' || pr.from.endsWith('/')
    if (same && boundary && (!best || pr.from.length > best.from.length)) best = pr
  }
  if (!best) return null
  return best.to + s.slice(best.from.length)
}

/**
 * Find a file the way a case-insensitive filesystem would. Libraries from Windows and macOS
 * often differ from the real file in letter case or accent encoding (NFC vs NFD), and Linux
 * treats those as different names. Returns the real path, or null if missing or ambiguous.
 */
const dirCache = new Map()
function listDir(dir) {
  if (!dirCache.has(dir)) {
    let entries = null
    try { entries = readdirSync(dir) } catch {}
    dirCache.set(dir, entries)
  }
  return dirCache.get(dir)
}
const fold = (s) => s.normalize('NFC').toLowerCase()
function resolveFile(p) {
  if (existsSync(p)) return p
  const parts = p.split('/')
  let cur = parts[0] === '' ? '/' : parts[0]
  for (let i = 1; i < parts.length; i++) {
    const want = parts[i]
    if (!want) continue
    const entries = listDir(cur)
    if (!entries) return null
    let hit = entries.find((e) => e === want) ?? entries.find((e) => e.normalize('NFC') === want.normalize('NFC'))
    if (!hit) {
      const loose = entries.filter((e) => fold(e) === fold(want))
      if (loose.length !== 1) return null
      hit = loose[0]
    }
    cur = cur === '/' ? '/' + hit : join(cur, hit)
  }
  return existsSync(cur) ? cur : null
}

// ---------- database ----------
function open(path, key, readonly) {
  const db = new Database(path, { readonly, fileMustExist: true })
  db.pragma("cipher='sqlcipher'")
  db.pragma('legacy=4')
  db.pragma(`key='${key}'`)
  try {
    db.prepare('select count(*) from djmdContent').get()
  } catch (e) {
    db.close()
    fail(`can't read ${path} as a rekordbox library (${e.message}). Is it master.db, and is the key right?`)
  }
  return db
}

const hasColumn = (db, table, col) => {
  try { return db.prepare(`pragma table_info("${table}")`).all().some((c) => c.name === col) } catch { return false }
}
const hasTable = (db, table) => !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table)

function overview(db, depth) {
  const groups = new Map()
  const rows = db.prepare('select FolderPath from djmdContent where coalesce(rb_local_deleted,0)=0').all()
  for (const { FolderPath } of rows) {
    if (!FolderPath) continue
    const s = slashes(FolderPath)
    const parts = s.split('/')
    const dirParts = parts.slice(0, -1)
    const take = s.startsWith('/') ? depth + 1 : depth
    const key = dirParts.slice(0, take).join('/') || '/'
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  console.log(`\n${rows.length} tracks. Music folders (top ${depth} levels):\n`)
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(6)}  ${k}`)
  }
  if (hasTable(db, 'contentFile')) {
    const share = db.prepare("select rb_local_path p from contentFile where rb_local_path like '%/PIONEER/%' limit 1").get()
    if (share?.p) {
      const root = share.p.slice(0, slashes(share.p).indexOf('/PIONEER/'))
      console.log(`\nAnalysis files (rekordbox "share" folder): ${root}`)
      console.log('  Add a second --from/--to pair for it if that folder moves too.')
    }
  }
  const drv = hasTable(db, 'djmdProperty') && hasColumn(db, 'djmdProperty', 'BaseDBDrive')
    ? db.prepare('select BaseDBDrive b, CurrentDBDrive c from djmdProperty limit 1').get() : null
  if (drv?.b && drv?.c && drv.b !== drv.c) {
    console.log(`\nNote: this library has a drive substitution set (${drv.b} -> ${drv.c}); the app swaps that drive`)
    console.log('  when reading paths. Use the paths as listed above for --from.')
  }
  console.log('\nNext: run again with --from <old folder> --to <new folder> to see what would change.')
}

function plan(db, pairs, check) {
  const changes = [] // { table, col, rowid, oldPath, newPath, fileName? }
  const perColumn = []
  const missing = []
  let caseFixed = 0, checked = 0, liveMoved = 0
  const canCheck = check && pairs.every((p) => p.toWin === (process.platform === 'win32'))
  const fileIdCol = hasColumn(db, 'djmdContent', 'rb_file_id')
  for (const [table, col] of PATH_COLUMNS) {
    if (!hasTable(db, table) || !hasColumn(db, table, col)) continue
    let n = 0
    const rows = db.prepare(`select rowid as rid, "${col}" as p ${table === 'djmdContent' ? ', FileNameL as fn, coalesce(rb_local_deleted,0) as del' : ''} from "${table}"`).all()
    for (const r of rows) {
      let np = mapPath(r.p, pairs)
      if (np === null || np === r.p) continue
      const ch = { table, col, rowid: r.rid, oldPath: r.p, newPath: np }
      const isTrackFile = table === 'djmdContent' && col === 'FolderPath'
      // rb_file_id is the file system's number for the file (inode / NTFS index), which Auto Relocate
      // uses to find moved files. The old machine's number means nothing here, so it is replaced with
      // the new file's number, or 0 ("unknown", as rekordbox stores for an unreadable file).
      if (isTrackFile && fileIdCol) ch.fileId = '0'
      if (isTrackFile && !r.del) liveMoved++
      if (isTrackFile && canCheck && !r.del) {
        checked++
        const real = resolveFile(np)
        if (!real) missing.push(np)
        else {
          if (real !== np) {
            caseFixed++
            ch.newPath = np = real
            if (r.fn && basename(real) !== r.fn) ch.fileName = basename(real)
          }
          if (fileIdCol) ch.fileId = fileIdOf(real)
        }
      }
      changes.push(ch)
      n++
    }
    if (n) perColumn.push(`${table}.${col}: ${n}`)
  }
  return { changes, perColumn, missing, caseFixed, checked, canCheck, liveMoved }
}

function report(db, p, pairs, check) {
  const tracks = p.changes.filter((c) => c.table === 'djmdContent' && c.col === 'FolderPath')
  console.log('\nFolder pairs:')
  for (const pr of pairs) console.log(`  ${pr.from}  ->  ${pr.to}`)
  console.log(`\nPaths to change: ${p.changes.length}${p.perColumn.length ? '  (' + p.perColumn.join(', ') + ')' : ''}`)
  console.log(`Tracks moved: ${p.liveMoved}`)
  const total = db.prepare('select count(*) n from djmdContent where coalesce(rb_local_deleted,0)=0').get().n
  const untouched = total - p.liveMoved
  if (untouched > 0) console.log(`Tracks not under any --from folder (left as they are): ${untouched}`)
  for (const c of tracks.slice(0, 3)) console.log(`  e.g. ${c.oldPath}\n    -> ${c.newPath}`)
  if (!check) console.log('\nFile check skipped (--no-check).')
  else if (!p.canCheck) console.log('\nFile check skipped: the new folders are for another operating system. Run it there to check, or use --no-check.')
  else {
    console.log(`\nChecked on this computer: ${p.checked - p.missing.length} of ${p.checked} files found.`)
    if (p.caseFixed) console.log(`  ${p.caseFixed} found under a slightly different name (letter case or accents); the real name is used.`)
    if (p.missing.length) {
      console.log(`  ${p.missing.length} not found. They are still moved, and show as missing until the file is there:`)
      for (const m of p.missing.slice(0, 10)) console.log(`    ${m}`)
      if (p.missing.length > 10) console.log(`    ... and ${p.missing.length - 10} more`)
    }
  }
}

/** juce::File::getFileIdentifier as rekordbox stores it: the inode (NTFS file index on Windows) as signed 64-bit text. */
function fileIdOf(path) {
  try { return BigInt.asIntN(64, lstatSync(path, { bigint: true }).ino).toString() } catch { return '0' }
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' +00:00')
}

function write(opts, p) {
  const out = opts.out
  if (out === opts.input) fail('--out must be a different file from the input')
  if (existsSync(out) && !opts.force) fail(`${out} already exists (use --force to overwrite)`)
  for (const s of ['', '-wal', '-shm']) rmSync(out + s, { force: true })
  copyFileSync(opts.input, out)
  if (existsSync(opts.input + '-wal')) copyFileSync(opts.input + '-wal', out + '-wal')

  const db = open(out, opts.key, false)
  const now = nowStamp()
  const apply = db.transaction(() => {
    let usn = db.prepare("select int_1 from agentRegistry where registry_id='localUpdateCount'").get()?.int_1 ?? null
    if (usn !== null) {
      for (const t of new Set([...USN_TABLES, ...p.changes.map((c) => c.table)])) {
        if (hasTable(db, t) && hasColumn(db, t, 'rb_local_usn')) usn = Math.max(usn, db.prepare(`select coalesce(max(rb_local_usn),0) m from "${t}"`).get().m)
      }
    }
    const touched = new Map() // "table:rowid" -> true, so a row gets one new usn
    for (const c of p.changes) {
      db.prepare(`update "${c.table}" set "${c.col}"=? where rowid=?`).run(c.newPath, c.rowid)
      if (c.fileName) db.prepare('update djmdContent set FileNameL=? where rowid=?').run(c.fileName, c.rowid)
      if (c.fileId !== undefined) db.prepare('update djmdContent set rb_file_id=? where rowid=?').run(c.fileId, c.rowid)
      const k = c.table + ':' + c.rowid
      if (touched.has(k)) continue
      touched.set(k, true)
      if (usn !== null && hasColumn(db, c.table, 'rb_local_usn')) {
        usn++
        db.prepare(`update "${c.table}" set rb_local_usn=? where rowid=?`).run(usn, c.rowid)
      }
      if (hasColumn(db, c.table, 'updated_at')) db.prepare(`update "${c.table}" set updated_at=? where rowid=?`).run(now, c.rowid)
    }
    if (usn !== null) db.prepare("update agentRegistry set int_1=?, updated_at=? where registry_id='localUpdateCount'").run(usn, now)
  })
  apply()
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
  return verify(opts, p)
}

function verify(opts, p) {
  const problems = []
  const a = open(opts.input, opts.key, true)
  const b = open(opts.out, opts.key, true)
  const ic = b.pragma('integrity_check', { simple: true })
  if (ic !== 'ok') problems.push(`integrity check: ${ic}`)
  for (const t of ['djmdContent', 'contentFile', 'djmdPlaylist', 'djmdSongPlaylist', 'djmdCue']) {
    if (!hasTable(a, t)) continue
    const na = a.prepare(`select count(*) n from "${t}"`).get().n, nb = b.prepare(`select count(*) n from "${t}"`).get().n
    if (na !== nb) problems.push(`${t}: ${na} rows before, ${nb} after`)
  }
  for (const c of p.changes) {
    const got = b.prepare(`select "${c.col}" v from "${c.table}" where rowid=?`).get(c.rowid)?.v
    if (got !== c.newPath) { problems.push(`${c.table}.${c.col} row ${c.rowid} wasn't written`); break }
  }
  for (const [table, col] of PATH_COLUMNS) {
    if (!hasTable(b, table) || !hasColumn(b, table, col)) continue
    const left = b.prepare(`select "${col}" p from "${table}"`).all().filter((r) => mapPath(r.p, opts.pairs) !== null && mapPath(r.p, opts.pairs) !== r.p).length
    if (left) problems.push(`${table}.${col}: ${left} paths still under an old folder`)
  }
  a.close(); b.close()
  // read-only checks leave an empty -wal and a -shm next to the output; tidy them up
  if (existsSync(opts.out + '-wal') && statSync(opts.out + '-wal').size === 0) {
    rmSync(opts.out + '-wal', { force: true })
    rmSync(opts.out + '-shm', { force: true })
  }
  return problems
}

// ---------- main ----------
const opts = parseArgs(process.argv.slice(2))
if (!existsSync(opts.input)) fail(`${opts.input} not found`)
const wal = opts.input + '-wal'
if (existsSync(wal) && statSync(wal).size > 0 && !opts.force) {
  fail(`${basename(wal)} is not empty, so rekordbox or rbxport probably still has the library open. Close it and try again (or --force).`)
}

const db = open(opts.input, opts.key, true)
if (!opts.pairs.length) {
  overview(db, opts.depth)
  db.close()
  process.exit(0)
}

const p = plan(db, opts.pairs, opts.check)
report(db, p, opts.pairs, opts.check)
db.close()

if (!p.changes.length) {
  console.log('\nNothing to change: no paths start with the --from folder(s). Run without --from to see the folders in this library.')
  process.exit(opts.out ? 1 : 0)
}
if (!opts.out) {
  console.log('\nDry run, nothing written. Add --out <file> to write the relocated library.')
  process.exit(0)
}

const problems = write(opts, p)
if (problems.length) {
  for (const s of ['', '-wal', '-shm']) rmSync(opts.out + s, { force: true })
  console.error('\nCheck failed, nothing written:')
  for (const x of problems) console.error(`  ${x}`)
  process.exit(1)
}
if (p.missing.length) writeFileSync(opts.out + '.missing.txt', p.missing.join('\n') + '\n')
console.log(`\nWritten and checked: ${opts.out}`)
if (p.missing.length) console.log(`List of files not found: ${opts.out}.missing.txt`)
console.log(`
Next:
  1. Close rekordbox / rbxport.
  2. Keep your current master.db as a backup.
  3. Copy ${basename(opts.out)} over master.db (and delete any master.db-wal / master.db-shm next to it).
  4. Start the app and check a few tracks play.`)
