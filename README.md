# rekordbox-relocate

Move a rekordbox / [rbxport](https://github.com/chrisle/rbxport) library to new music folders, for example from **Windows to Linux**, without re-importing anything. It rewrites the track paths in `master.db` and nothing else, so your cues, beat grids, playlists, play counts and analysis all stay.

```
D:\MUSICDATA\Mp3\Artist\Track.mp3   ->   /home/me/music/MUSICDATA/Artist/Track.mp3
```

- **Never changes your library file.** The result goes to a new file, which is checked after writing (integrity, row counts, every new path). If any check fails, it's deleted.
- **Dry run first.** It shows how many tracks move and which files it can't find, before writing anything.
- **Handles the Windows → Linux traps.** Windows paths match regardless of case and slash direction. On Linux, a file stored as `Track.mp3` but named `track.MP3` on disk is found, and so is a name whose accents are encoded differently (macOS vs Linux). The library then points at the real name.
- **Moves the analysis folder too**, if you give it a second folder pair.

Not affiliated with AlphaTheta or Pioneer DJ. Keep a backup of your `master.db`.

## Install

Needs [Node.js](https://nodejs.org) 20 or newer.

```sh
git clone https://github.com/themisterchong/rekordbox-relocate
cd rekordbox-relocate
npm install
```

## Use

**Close rekordbox and rbxport first.** Work on a copy of `master.db`:

| | default location of `master.db` |
|---|---|
| Windows | `%APPDATA%\Pioneer\rekordbox\master.db` |
| macOS | `~/Library/Pioneer/rekordbox/master.db` |
| Linux (rbxport) | wherever your rbxport library is |

### 1. See where your music is

```sh
node relocate.mjs master.db
```
```
1840 tracks. Music folders (top 3 levels):

    1702  D:/MUSICDATA/Mp3
     138  C:/Users/dj/Music

Analysis files (rekordbox "share" folder): C:/Users/dj/AppData/Roaming/Pioneer/rekordbox/share
```

### 2. Dry run

```sh
node relocate.mjs master.db --from 'D:\MUSICDATA\Mp3' --to /home/me/music/MUSICDATA
```

It lists what would change and, on the computer where the music now is, how many files it found. Nothing is written.

More folders? Repeat the pair. The longest matching `--from` wins:

```sh
node relocate.mjs master.db \
  --from 'D:\MUSICDATA\Mp3'   --to /home/me/music/MUSICDATA \
  --from 'C:\Users\dj\Music'  --to /home/me/music/other \
  --from 'C:\Users\dj\AppData\Roaming\Pioneer\rekordbox\share' --to /home/me/.rekordbox/share
```

### 3. Write it

Add `--out`:

```sh
node relocate.mjs master.db --from 'D:\MUSICDATA\Mp3' --to /home/me/music/MUSICDATA --out master-linux.db
```

Then keep your old `master.db` as a backup, copy `master-linux.db` over it (delete any `master.db-wal` / `master.db-shm` next to it), start the app and play a few tracks.

Files it couldn't find are still moved, and are listed in `master-linux.db.missing.txt`. They show as missing in the app until the file is there.

### Options

| option | |
|---|---|
| `--from` / `--to` | folder pair; repeat for more |
| `--out <file>` | write the result here (without it: dry run) |
| `--no-check` | don't look for the files, e.g. when running on Windows before copying the music |
| `--force` | overwrite `--out`, or run even if the library looks open |
| `--key <hex>` | SQLCipher key, if your `master.db` uses another one |
| `--depth <n>` | folder depth for the overview (default 3) |

## What it changes

Only rows whose path starts with a `--from` folder, in these columns:

- `djmdContent.FolderPath`, `OrgFolderPath`, `rb_LocalFolderPath` (where the track's file is)
- `contentFile`, `imageFile`, `settingFile` `.rb_local_path` (analysis and artwork files in the share folder)
- `djmdContent.FileNameL`, only when the real file's name differs in case or accents

Each changed row gets a new `rb_local_usn` and `updated_at`, the same way rekordbox marks its own edits.

## Tested

- Round trip on a real 1,509-track rekordbox 7 library: macOS paths → Windows paths → back gives byte-identical paths; tracks, playlists and playlist entries unchanged.
- Case-sensitive filesystem: tracks stored as `House1.wav` are matched to `HOUSE1.WAV` on disk.
- Windows → Linux on a real migration: not yet. Reports welcome.

## License

MIT
