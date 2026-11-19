# Archive fixtures

Real ARCHIVE.md v1 files (apron-web's `ARCHIVE.md`), used by
`test/history/archive-format.test.ts` and `test/history/render.test.ts`.

Each `<scene>.jsonl` is a verbatim copy of `scenes/<scene>/scene.jsonl` from
<https://github.com/apron-chat/scene.apron.chat>, commit
`799dc0a80289ac08cf60048a56fedb058bdc11a6` (2026-11-09). All seven scenes
are included (about 250 KB in all). The images and audio the scenes link to
are not copied: archives hold no files (ARCHIVE.md §5).

Source license: MIT, Copyright (c) 2026 Apron Chat Protocol (the
`LICENSE` of scene.apron.chat).

The Workers test pool has no filesystem, so tests import these files
through `index.ts`, which bundles them as strings with Vite's
`import.meta.glob(..., { query: "?raw" })`. To refresh them, copy the
`scene.jsonl` files again and update the commit above.
