# Gallery: on-device descriptions, keywords, objects and named faces

**Date:** 2026-11-24
**Builds on:** `2026-11-24-gallery-photo-score-design.md`
**Status:** design, not built.

## Why

Steven picks photos for a book out of folders of thousands. He wants to find photos by what is in them
("dog", "beach", "birthday cake"), and by who is in them, the way Picasa did, without any subscription
or cloud service: everything runs on his computer. The work happens quietly in the background after a
folder loads, and what was found shows in the details panel as a description plus keywords, objects and
names that can be clicked to filter the grid.

## Goals

1. **Models downloaded on request, from Hugging Face**, never bundled with the app. In Settings the
   person picks which parts they want and which model for each (smaller and faster, or larger and
   better), sees the download size, and downloads it with progress and Cancel. Nothing is downloaded
   until they ask.
2. **Background tagging** of every photo in the open folder once the folder scan is done: a written
   description, keywords and objects. Low priority, one photo at a time, with progress, Pause and Resume;
   resumes where it left off next time; a photo is looked at once (cached by content, so a rename or move
   does not redo it).
3. **Details panel:** a "What's in it" section with the description (the machine's, kept apart from the
   person's own Description), keyword chips and object chips. Clicking a chip filters the grid to photos
   with the same keyword or object; the filter shows as a removable chip in the filter bar.
4. **Search** finds photos by their keywords, objects, machine description and confirmed names, as well
   as by the description and notes typed today. With the keyword model, a search can also match by meaning
   ("kids on a beach"), not only by exact words.
5. **Faces with names:** faces are found and grouped by likeness. The person names a face or a group; the
   gallery then suggests that name on other faces ("Ann?"), and **only a Yes from the person makes a face
   Ann.** Confirmed names join the photo's existing People list, so filtering, the photo score and the
   editor already use them.

## Non-goals

- No cloud service, account, API key or subscription, ever.
- The photobook editor does not run the models and does not read keywords or objects (it reads confirmed
  names, through People, as it does today).
- No sort by keyword, no automatic albums, no "best photo of each person".
- Not for the full-screen viewer (it keeps showing what it shows today).

## Anti-goals

- **No name is put on a face without the person's Yes.** A suggestion is a question, not a fact: it is
  not searchable, not filterable and never written to `photoinfo.json` until confirmed.
- **Nothing leaves the computer except the model download** the person started, from Hugging Face. The
  network stays closed otherwise (the existing guard: only map tiles, only after Load maps).
- **Face fingerprints (embeddings) stay in the gallery's cache on this computer only**: never in
  `photoinfo.json`, never in an export, never sent anywhere.
- The person's own Description and notes are never changed by the machine.
- The review stays responsive: tagging never blocks the grid, preview, keys, saving or the folder scan.
- A model that fails to load (bad download, wrong file) never crashes the app: the part is shown as not
  working, with a way to download it again.

## Approaches

- **Chosen — B + C plus faces:** a picture–text matcher (CLIP-style) for keywords and search by meaning,
  a caption model (Florence-2) for the description and the object list, and a face finder + face matcher
  (OpenCV's YuNet + SFace) for faces. Most capable; largest download and slowest scan.
- *Object finder only (COCO-style detector):* small and fast but only ~80 object types; no scenes, no
  description. Rejected: does not find "beach" or "sunset", which Steven searches for.
- *Captions only:* a description, and keywords taken from its words; no search by meaning, and keyword
  quality depends on the sentence. Rejected as the only model; kept as one part of the chosen design.
- **Model source — chosen: Hugging Face, straight from the model pages**, each file pinned to one commit
  and checked against a SHA-256 the app carries. *Own GitHub release mirror*: more control, but Steven
  chose Hugging Face. *Install from a file*: not in this design (see Left to the builder).

## Decisions

### Model choice and download (Settings → "Photo tagging")
- Three parts, each optional and independent: **Descriptions and objects** (caption model),
  **Keywords and search by meaning** (picture–text model), **Faces** (finder + matcher).
- For the first two the person picks one of at least two models: a *smaller* one (faster, smaller
  download) and a *larger* one (better, slower). Faces has one choice (YuNet + SFace).
  Candidates, to be measured on a few hundred real photos before the list is fixed:
  - Descriptions: `onnx-community/Florence-2-base-ft` (smaller), `onnx-community/Florence-2-large-ft` (larger).
  - Keywords: `Xenova/clip-vit-base-patch32` (smaller), a larger CLIP (e.g. `Xenova/clip-vit-large-patch14`).
  - Faces: `opencv/face_detection_yunet` + `opencv/face_recognition_sface`.
  Each choice shows its download size, a rough speed ("about 2 s a photo on this computer" once measured
  here, otherwise a typical figure), and its licence. Only models whose licence allows use and
  redistribution in this app are offered (MIT, Apache-2.0, BSD); the InsightFace models are not
  (non-commercial research only).
- The list of models, with each file's repository, pinned commit, path, size and SHA-256, is a table in
  the app's code (a model catalogue), not fetched from anywhere. Changing it is a code change.
- **Download:** started only from Settings; asks first ("Download Florence-2 base, 460 MB, from Hugging
  Face?"); progress, Cancel; resumes a broken download; checks every file's SHA-256 before use and deletes
  a file that does not match. Files go into the gallery's data folder under `models/<model id>/`. Settings
  shows what is downloaded, its size on disk, and **Remove**.
- The download runs in Node (the main process or the gallery server), not in the page, so Chromium's
  network guard and host rules stay as they are; it may reach only `huggingface.co` and the download hosts
  it redirects to, only for files in the catalogue, only while a download the person started is running.
  The program's description ("Uses the network only for map tiles…") and the README are updated to say so.
- Switching to the other model of a part re-tags photos with it in the background (old results are kept
  until replaced).

### Background tagging
- Runs in the gallery server, in a worker thread (or child process) with a capped number of threads, so
  the server stays responsive. One photo at a time, from its 1600 px working picture.
- Starts when the open folder's scan has finished and at least one part is downloaded and switched on.
  Order: the selected photo first, then the photos shown in the grid, then the rest.
- Progress in the gallery's bar ("Tagging 120 of 2,140 · Pause"). Pause holds it until Resume or the next
  folder; closing the app stops it; the next open of the folder resumes with the photos not yet done.
- **What "the same photo" means:** a new content key, the hash of the decoded pixels of the photo's
  working picture, worked out during the folder scan (which decodes it already). A rename, a move or a
  metadata-only change (a date or tag written by another tool) keeps the key and the results; changed
  pixels (an edit saved into the file) make a new key and the photo is tagged again. The existing `key`
  (path, size, time) stays for thumbnails. *(My call.)*
- Results are kept in the gallery's catalogue (SQLite), keyed by the photo's content key and the model
  that made them: description, keywords with confidence, objects with label, box and confidence, the
  picture embedding (for search by meaning), and faces (box, fingerprint, and their naming state).
- A photo that fails (unreadable, model error) is marked failed for that model and skipped, and the bar
  says how many failed; it is not retried until the model or the photo changes.

### Details panel: "What's in it"
- A new collapsible section, after Photo: the machine **description** (labelled as written by the
  computer, with the model's name in a tooltip), **Keywords** chips, **Objects** chips (with a count when
  more than one: "person ×3"), and **People** faces (see Faces). "Not looked at yet" while waiting;
  "Tagging is off" with a link to Settings when no part is downloaded.
- Clicking a chip sets a filter: only photos with that keyword / object / name. The filter bar shows it as
  a chip with ×; several chips narrow further (all must match). Clicking a chip again clears it.
- The keyword list shown is the confident ones only (a threshold the builder sets from measurement), at
  most about 12.

### Search
- The existing search box matches, case-insensitively: the person's description and notes (as today),
  the machine description, keywords, objects and confirmed names.
- With the keyword model on, a search that matches few or no words also ranks photos by meaning (the
  text's embedding against each photo's picture embedding) and shows those above a threshold, best first,
  under a note "Also matching by meaning". *(My call: words first, meaning second, so an exact keyword is
  never buried.)*

### Faces
- **People are known across every folder** (Steven's answer, as Picasa did): a person confirmed in one
  folder is suggested in any other. The gallery's catalogue keeps one list of people for all folders, with
  each person's confirmed faces (fingerprints, in the cache only). Opening a folder whose `photoinfo.json`
  has confirmed `faces` (from another computer, or after a lost cache) adds them to that list by name.
- Each face found gets a box and a fingerprint. The open folder's unnamed faces are grouped by likeness
  (clustering over the fingerprints) into unnamed groups.
- **Naming:** on the preview, faint boxes over faces; clicking a face asks "Who is this?" with every known
  person offered (from all folders, most used first) and a box to type a new name. A **People** view (a
  third tab beside Grid and Map) lists the people in the open folder with their faces, the unnamed groups,
  and a way to show everyone the gallery knows; a whole group can be named at once.
- **Suggestions always ask.** A face close to a named person's confirmed faces shows "Ann?" (dashed) on
  the preview and in the People view, with **Yes** / **No**. Yes makes it Ann; No records "not Ann" and
  the face is not suggested as Ann again. Suggestions are not searchable or filterable and are not written
  anywhere but the cache. In the People view, the person may answer Yes for several suggested faces at
  once only while those faces are on screen (e.g. "Yes to these 12"). *(My call: still a Yes for every
  face, from someone looking at it.)*
- **Confirmed** names: the name is added to the photo's `people` in `photoinfo.json` (as typed names are
  today), and the face's box and name are added to a new `faces` field there
  (`faces: [{ x, y, w, h, name }]`, box as fractions of the upright photo) so the naming survives a lost
  cache and travels with the folder. No fingerprint is written. *(My call.)*
- **Naming a whole group** confirms only the faces of the group that are on screen when the name is given;
  the group's other faces become "Ann?" suggestions that still need a Yes. *(My call, from "always ask".)*
- **Boxes and edits:** a face box is a fraction of the upright original photo (EXIF orientation applied,
  no crop or rotate edit). An edit in `photoinfo.json` only changes how the boxes are drawn (through the same
  geometry as the edit, `src/core/photoEdit.ts`). Saving an edit into the photo file maps each confirmed
  face's box through the edit into the new picture and keeps it; a face the crop cuts out is dropped from
  `faces` (its name stays in `people` only if typed there by hand). *(My call.)*
- Removing a name from a face takes it out of `faces`, and out of `people` when no other face in the photo
  has that name (a name typed by hand into People stays).
- Merge two people, rename a person, move a wrongly confirmed face to another person or to unnamed: in the
  People view. A rename or merge applies everywhere: it rewrites the `faces` and `people` entries of every
  folder that has that person and can be reached now (asking first: "Rename Ann to Ann Lee in 14 photos in
  3 folders?"), and is remembered for folders on a drive not connected, which are brought up to date when
  next opened. *(My call.)*
- Every naming change is a Ctrl+Z step (the undo stack from the score design); a rename or merge across
  folders is one step.

## Left to the builder
- Which inference library: Transformers.js (`@huggingface/transformers`, onnxruntime-node underneath) is
  the expected route for CLIP and Florence-2 (its Florence-2 support was marked experimental on the model
  cards — check the current release first); YuNet and SFace through onnxruntime-node directly, with their
  own pre- and post-processing.
- The exact model list, quantisation (fp32 / fp16 / q8 / q4), thresholds, clustering method and the
  keyword vocabulary for CLIP, all from measurement on a few hundred real photos.
- How Pause interacts with a photo mid-way (finish it or drop it).
- **Speed and hardware** (Steven did not say what graphics card he has): build for the processor (CPU)
  first and measure seconds per photo for each offered model on a typical laptop; show that in Settings.
  Treat a first pass that runs overnight as acceptable. Graphics-card acceleration (e.g. onnxruntime's
  DirectML build on Windows) is worth adding only if the measurements show the larger models are
  unusable without it, and it must not be required. *(My call; revisit with the measurements.)*
- "Install from a file" for computers that are never online: a likely follow-up, not in this design.
- File layout, component names, CSS; tests in the gallery's style (Vitest for pure helpers, catalogue
  and download logic with injected seams and tiny fake models; Playwright for the screen with the tagging
  results faked).
