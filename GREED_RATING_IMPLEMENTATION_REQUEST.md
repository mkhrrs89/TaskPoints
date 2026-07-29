# Temporary implementation request

This file exists only to open the implementation PR and must be deleted before the PR is merged.

Implement GitHub issue #796 exactly:

- Add a persisted numeric player field `greed`, clamped to 0–100.
- Existing players missing it default to 0.
- Create Player form: Greed control next to Intimidation/Poise, suggested/default 25, save it, reset to 25.
- Existing player editor/card details: show and edit Greed next to Intimidation/Poise, missing values 0.
- Player Ratings page: editable/sortable Greed column next to Intimidation/Poise, CSV export support, missing values 0.
- Preserve through normal save/import/export.
- Do not connect Greed to OVR, scoring, matchup simulation, commentary, scheduling, or any gameplay behavior.
- Preserve all current player create/edit/save/image-crop behavior.
- Add focused tests and run the full suite.
- Delete this temporary request file as part of the implementation.
