# Photo Tool

A desktop program for looking through a folder of photos and starring the best ones. It is installed on its own and runs beside [Photobook Editor](../photobook-editor/README.md); the two share stars and notes through `photoinfo.json` (below). It never changes, renames or moves a photo unless you ask: **Delete** sends a photo to the Recycle Bin, and editing (below) can, if you choose to save into the photo file, replace a photo with its edited version after sending the original to the Recycle Bin. It uses the network only for OpenStreetMap map tiles, and only after you choose **Load maps** on the Map tab, and to download photo-tagging models from Hugging Face when you ask for one in Settings (see Photo tagging); the editor never uses the network. Windows and Linux only; there is no web version.

How to build, run, test and package it, and where its data lives: see the [README at the top of the repository](../README.md).

## Using it

**Starting it.** On Windows the installer adds **Photo Tool** to the Start menu and the desktop. On Linux the `.deb` adds it to the applications menu. From a command line, give it a folder to open that folder straight away: `"Photo Tool.exe" <folder>` on Windows, `photo-tool <folder>` on Linux.

**Opening a folder.** Click **Open folder**, or use **File → Open folder…** (Ctrl+O). Tick **Include subfolders** first to see the photos in every folder below it. The start screen lists recent folders; one that can't be found (a drive that isn't plugged in) is greyed out. Photos appear while the folder is read, and a bar shows how far along it is. A folder opened before is quick: its thumbnails are kept.

**Three panes.** The thumbnails are on the left, a large preview of the selected photo is in the middle, and its details are on the right. Drag the two dividers to change the widths; they are remembered. Click a photo to see it in the preview. Ctrl-click adds or removes a photo, and Shift-click selects a range. Drag the size slider to make thumbnails bigger or smaller. Double-click a photo or the preview, or press Enter, to view it full screen.

**Zooming the preview.** Turn the mouse wheel over the preview to zoom in, from 1 to 8 times, toward the pointer. Drag to move the photo around. While zoomed, a small map in the top right corner shows where you are; click or drag it to move the view. Double-click to go back to the whole photo. (Double-click at the whole photo still opens it full screen.) The sharper full-size picture is loaded once you zoom far enough to need it.

**Keys.** They work in the grid and the preview, and are ignored while you type in a field. The full-screen viewer has its own (last line).

- **F**: favourite (star) the photo, or unfavourite it. With several photos selected, they all take the opposite of the state of the photo shown in the preview (the focused one). **H** works the same way.
- **H**: hide the photo, or show it again. Hidden photos are left out of the grid until you change the **Hidden** filter. After H, the selection moves on to the next photo, so you can press H down a run of bad shots.
- **Left** and **Right**: move to the previous or next photo.
- **Up** and **Down**: add 1 to the photo score, or take 1 away (every selected photo when several are). Each press counts once; holding the key doesn't repeat. A green "+1" or red "−1" with the new score shows on the preview for a moment. See Photo score below.
- **Home** and **End**: the first or last photo.
- **Ctrl+Z**: undo the last change: a favourite, a hide, a score nudge, Done in edit mode, Revert to original, a saved edit in the info file, or a field typed in the details. The last 100 changes are kept until you open another folder. It doesn't undo moving photos to the Recycle Bin or saving into the photo file; get those back from the Recycle Bin. In a text field, Ctrl+Z undoes your typing as usual.
- **E**: edit the photo (see Editing photos below).
- **Enter** (or **Space**): view the photo full screen. **Esc** closes the viewer.
- In the full-screen viewer, **Left** and **Right** step through the photos, **F** (or **S**) favourites the photo, **H** hides it, and **I** shows or hides its details.

**Photo score.** Every photo gets a score, shown at the top of the details and in the bottom-right corner of its thumbnail ("–" until the photo has been read). Hover the score in the details to see what made it. It is made of:

- **Focus**, up to 35: how sharp the photo is next to the others in this folder.
- **Exposure**, up to 20: brightness near the middle.
- **Clipping**, down to −15: when more than 2 % of the photo is blown to white or crushed to black.
- **Colour variety**, up to 10, and **Composition**, up to 5: many colours across the frame, and the subject near a third rather than dead centre.
- **People**, 5 for each person tagged, up to 10.
- **Size**, up to 10: megapixels, full points at 8.
- **Burst**, −10: a near-identical shot when another in its burst is better.
- **Favourite** +50, **Hidden** −50, and **your nudges** from Up and Down, kept in `photoinfo.json` as `scoreAdjust`.

There is no top or bottom; a plain photo lands roughly between 30 and 90. Choose **Sort → Photo score** to see the highest first; a photo moves as its score changes.

**Editing photos.** Click **Edit** under the preview, press **E**, or right-click and choose **Edit**. The whole photo is shown with a crop box over it: drag a corner or an edge to resize it, or drag inside to move it. The bar under it has:

- **Aspect presets**: Free, Original, Square, 4:5, 3:2 and 16:9, and a button to swap portrait and landscape.
- **Rotate 90°** (or **R**): turns the photo anticlockwise.
- **Straighten**: a slider from -45° to +45° in half-degree steps. Double-click it to reset it.
- **Reset**, **Cancel** (**Esc**) and **Done** (**Enter**). While editing, only Esc, Enter and R act as keys.

**Done** keeps the edit as *unsaved*: the photo's tile gets a marker, and the preview caption says "Edited · not saved". Clicking another photo while editing does the same. Edit is unavailable for a photo while it is being saved. Nothing is written until you save:

- **Save** writes the edit (where it goes depends on the setting below).
- **Save as…** writes the edited photo to a new file you name, with a Save dialog; the original is never overwritten. Save as into the open folder makes the copy appear in the grid with the original's star, people, date, location, description and notes. If you type a different extension, the file gets one that fits its format (.jpg, .png or .webp), and Save as refuses a name that already exists once the extension is changed.
- **Save all (N)** saves every unsaved edit, one after another, and says how it went.
- **Revert to original** removes an edit saved in the info file.

Unsaved edits are lost if you close the Photo Tool window or open another folder, so both ask first ("Close without saving" or "Open without saving", or keep editing).

**Settings.** The **⚙** button in the top bar opens Settings. **When I save an edit** has two choices, kept at once:

- **Change only the photo's info file** (the default). The photo is untouched; the crop and rotation go into `photoinfo.json`, and Photobook Editor applies them when it imports or re-syncs the photo. If you change the edit later and re-sync, the editor applies the new one. The editor renders such a photo as a JPEG, so a PNG's transparency is lost there.
- **Change the photo file itself**. The photo is rewritten (JPEG at quality 95, PNG and WebP in their own format, EXIF kept) and the original goes to the Recycle Bin; if the bin is not available, nothing changes. A HEIC photo can only be saved with **Save as**, as a JPEG. This choice needs the desktop program.

Run from source in a plain browser (`npm run dev:photo-tool`), Photo Tool can edit and save to the info file, but Save as and saving into the photo file need the desktop program.

**Stacks.** Near-duplicates are folded into one tile with a "x N" badge, showing the favourite or else the best of the group. Click the badge to unfold the stack, and click it again to fold it. Untick **Stack similar** to see every photo on its own.

**Hidden.** The **Hidden** filter leaves hidden photos out (the default), shows them dimmed, or shows only them.

**Info sections.** The right-hand pane has sections you can fold, and it remembers which are open:

- **Photo**: date, size, megapixels, shape, format and folder.
- **Camera**: camera, lens, focal length, aperture, shutter speed, ISO, exposure compensation and flash, when the file has them.
- **What's in it**: what photo tagging found (see Photo tagging below): a sentence about the photo, its keywords and the objects in it. Click a keyword or an object to show only the photos that have it. **Regenerate**, under the sentence, asks the chosen descriptions model to describe the photo again in other words; the new sentence replaces the old one in the folder's `phototool-tags.json` (see Where the tags are kept, below), and the keywords and objects stay as they are. It works while tagging is paused.
- **Histogram**: red, green, blue and brightness, with the share of clipped shadows and highlights.
- **Place**, **People**, **Date and time**, and **Description and notes**: the fields you can type. Each is saved when you leave the field.

**Right-click menu.** Right-click a photo, or the preview, for:

- **Edit** (**E**), and, for a photo with an unsaved edit, **Save**, **Save as…**, **Save all** and **Revert to original** as above.
- **Copy to clipboard**: the photo itself, to paste into a chat, a document or an image editor.
- **Copy path to clipboard**: the file's full path (every selected path, one per line).
- **Show in file explorer**: opens the folder with the photo selected.
- **Delete**: asks first, then moves the photo to the Recycle Bin (the Trash on Linux), so it can be restored. If the bin is not available, the delete fails instead of erasing the file.
- **Favourite** and **Hide**, with their keys shown.

**Map tab.** The **Grid | Map** switch above the thumbnails shows the photos that have a location (from the camera's GPS or a place you typed) as small round pictures on an OpenStreetMap map. Photos close together merge into a bubble with a count; click it to zoom in. Click a photo to select it. The first time you open the Map tab it asks whether to load maps from the internet. **Load maps** downloads map tiles from OpenStreetMap, and nothing else leaves your computer: the requests carry no cookies, no referrer and no personal details. **Not now** keeps the markers on a plain background and makes no request. You can change your answer with the **Map: online** link on the map. With no connection, the markers still show, with "Map unavailable offline" over them.

**Sorting and filters.** Sort by **Date taken** (the default), **Most interesting**, **Main colour** or **File name**. Filters can be combined:

- starred or not starred;
- a date range (**From** and **To**);
- portrait or landscape;
- **Low quality** (blurry, too dark, too bright or low resolution, by the same rules as the editor's Clean up);
- **Near-duplicates**;
- **Hidden**: leave out, show or only;
- **Has location** and **Has people**;
- one subfolder;
- keywords and objects picked in **What's in it** (each shows in the bar with a **×** to take it away);
- **Search photos**: words in the descriptions and notes, and in what photo tagging found. With keywords on (see Photo tagging), the photos that match the words *by meaning* follow, under "Also matching by meaning": "coffee" also finds a photo tagged "cafe".

**Clear** turns every filter off.

**Dragging photos out.** Drag a photo from the grid into Photobook Editor or into Explorer. Select several first to drag them all, up to 500 at a time. The original files are dragged, so a HEIC photo arrives as its `.heic` file. Dropped on the editor, they go onto a frame, a page or the library (see the editor's README). Dropped in Explorer, they are copied there.

## Photo tagging

Photo Tool can look at each photo and write down what is in it, on this computer. It is off until you turn it on in **Settings → Photo tagging**, which has two parts, each **Off** or one of two models:

- **Descriptions and objects** (Florence-2): a sentence about the photo, and the things in it with a count ("person ×3"). The smaller model is 277 MB and takes about 6 s a photo; the larger is 832 MB and about 20 s.
- **Keywords and search by meaning** (CLIP): up to 12 keywords for each photo, and the search by meaning described above. The smaller model is 156 MB and takes well under a second a photo; the larger is 434 MB and about half a second.

A model is downloaded from Hugging Face only when you click **Download** and say yes to the size it shows. The files are pinned to one version and checked against their known fingerprints before use; a download can be cancelled, and continues where it stopped. **Remove** deletes a model's files. They are kept in Photo Tool's data folder, under `models`. Once downloaded, the models run on this computer, on its processor; the photos never leave it, and nothing else is sent anywhere. All four models are MIT licensed.

Once a folder is read, its photos are tagged one at a time in the background: the selected photo first, then the ones on screen, then the rest. The bar shows "Tagging 120 of 2,140" with **Pause** and **Resume**; Pause holds until Resume or until another folder is opened, and closing the folder stops tagging it. With the smaller models, a folder of 2,000 photos takes about 3½ hours, so a big folder is best left overnight. What was found is kept in the photo's own folder (below), by the photo's content, so a photo is looked at once even if it is renamed, moved or opened from another folder, and closing Photo Tool loses nothing. Choosing another model for a part looks at every photo again with it; until it has, the other model's results still show. A model that is damaged or won't load shows **Not working · Download again** in Settings (a damaged file is found and deleted, so Download again fetches it), and if tagging has to stop (say the disk is full) the bar says why, with **Try again**.

### Where the tags are kept

The descriptions, objects and keywords are written to a file called `phototool-tags.json` in the same folder as the photos, so they move with the folder: copy or move an album (say to another drive, or through iCloud to another computer), or reinstall Photo Tool, and the tags show as soon as the folder is opened, without running the models again. Beside it, `phototool-tags.vectors.json` keeps what search by meaning needs (one list of numbers per photo, from the keywords model; about 3 KB a photo). Both files hold only what the models made and can be deleted at any time: Photo Tool writes them again from its own copy the next time the folder is opened, or tags the photos again. Stars, people and notes stay in `photoinfo.json`.

```json
{
  "format": "phototool-tags/1",
  "photos": {
    "IMG_0042.jpg": {
      "models": {
        "florence2-base-q8": { "contentKey": "3f1c…", "fileKey": "fk1:9a0e…", "description": "A boat in a harbour.", "objects": [{ "label": "boat", "count": 2 }], "madeAt": "2026-11-25T10:00:00.000Z" },
        "clip-base-q8": { "contentKey": "3f1c…", "fileKey": "fk1:9a0e…", "keywords": [{ "label": "harbour", "score": 0.31 }], "madeAt": "2026-11-25T10:00:01.000Z" }
      }
    }
  }
}
```

- Photos are keyed by file name, and each model's result by the model it came from. Two fingerprints say which picture a result was made from. `fileKey` comes from the photo file's own bytes, so it is the same on every computer. `contentKey` comes from the thumbnail this computer made, so it can differ on another computer or after an update, and is used only as a quick first check. If the photo in that file is replaced or edited, the old result is not shown for it and the photo is tagged again. A photo renamed inside the folder keeps its tags.
- While a pass runs, the files are written at most every 5 minutes. They are also written when the pass ends or is paused, a minute after the last result, when the folder is closed, and when Photo Tool closes. Each write replaces the whole file, so a pass over 1,000 photos at the smaller model's 6 s a photo (about 100 minutes) writes them about 20 times, not 1,000. Fields and entries Photo Tool does not know are kept.
- A write that fails (the file is in use, say) is tried again after 30 s, then after longer and longer waits, up to 10 minutes. If a file cannot be read as JSON, it is left alone and is not written to until it is fixed or deleted. The two files are written separately, so a problem with one does not hold up the other.
- Only finished results are written. A photo a model could not look at is tried again when the folder is opened somewhere else.
- The folder's copy always wins. When the folder already has a result for a picture, a new result from tagging never replaces it, even if Photo Tool's own copy differs (because it was regenerated on another computer, say). Only **Regenerate** replaces it. Tags made before this file existed are written into it the first time the folder is opened.
- If the file cannot be read just then (a sync program has it locked, or an iCloud file is not downloaded while you are offline), Photo Tool does not tag that folder's photos until it can read the file. It never writes over a file it could not read.
- If the folder cannot be written, the files go into the shared folder's `phototool-tags` subfolder instead (`%APPDATA%\Photo Tools Shared\photoinfo\phototool-tags` on Windows). Once the folder can be written again, its own file and that copy are merged photo by photo: the folder's result wins unless the copy's is newer. The copy is then deleted. The album's own file never contains a path from your computer.
- While writing, Photo Tool uses a short-lived temporary file named `~$phototool-tags.json.<random>.tmp`, a name OneDrive and Dropbox do not sync. If Photo Tool is stopped in the middle of a write, the leftover is deleted the next time it writes to that folder.
- Two computers writing to the same synced album at the same moment can make the sync program keep both, as a conflict copy (for example `phototool-tags 2.json`). Photo Tool ignores those copies, and each computer writes what it has again the next time it opens the folder.
- Photo Tool also keeps a copy of everything in its catalogue (`gallery.sqlite` in its data folder). That copy is only a cache: deleting the data folder loses no tags.

## Stars and photoinfo.json

A photo's star, date, place, people and notes live in a small file called `photoinfo.json` in the same folder as the photo. Both programs read and write it: a star set in Photo Tool shows up in Photobook Editor within about 3 seconds, and the other way round, and a star added by another program (or by hand in Notepad) shows up too. Apart from the tags files (above), it is the only thing ever written beside your photos; the photos themselves are never changed, renamed or moved (unless you save an edit into the photo file, above).

```json
{
  "format": "photoinfo/1",
  "photos": {
    "IMG_0042.jpg": { "star": true, "people": ["Ana"], "date": "2023-08-12T14:30:00", "location": { "lat": 49.15, "lon": -125.9, "name": "Tofino" }, "description": "Low tide", "notes": "" }
  }
}
```

- Photos are keyed by file name only. Every field is optional. Fields a program does not know, and entries for photos that are not there, are kept every time it writes.
- A date, place, people or description in the file wins over what the photo itself says. In the editor, the star in the file wins over the one stored in its library.
- If the folder cannot be written (a read-only drive), the info goes into the folder both programs share instead, `Photo Tools Shared\photoinfo` (`%APPDATA%\Photo Tools Shared\photoinfo` on Windows, `~/.config/Photo Tools Shared/photoinfo` on Linux), and nothing is lost. Photo Tool shows "Read-only folder: stars kept in the shared folder" when that happens, and the editor still sees the stars.
- If the file cannot be read as JSON, it is left alone, and you are told so when you try to star something. Fix or delete the file.

**Tidy photo info…** removes info kept for photos that are no longer in the folder. Photo Tool's own thumbnails, recent folders and tagging models are in `%APPDATA%\Photo Tool\data` (`~/.config/Photo Tool/data` on Linux); **File → Open the data folder** shows it.

## Checking it works

`"Photo Tool.exe" --self-test <photo folder> --self-test-out <folder>` opens a copy of the folder, stars one photo and checks the star reached the copy's `photoinfo.json`, and checks the tagging worker loads. It writes `result.json` and exits 0 or 1, like the editor's self-test.
