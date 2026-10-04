# Vendored from ShogiHome

Files in this folder are copied from [ShogiHome](https://github.com/sunfish-shogi/shogihome)
at commit 9deabb4 (MIT License, Copyright (c) 2022 Kubo Ryosuke, see `LICENSE`).
The directory layout mirrors ShogiHome's `src/` so the original `@/...` imports resolve
through the `@` alias in `vite.config.ts`.

Changes from upstream:
- `common/settings/app.ts`, `common/settings/layout.ts`: trimmed to the enums the board needs.
- `common/i18n.ts`: replaced by a one-key stand-in.
- `renderer/view/primitive/BoardView.vue`: `alt` text on images (empty for decorative ones, words on the promote choice).

The piece, board and piece-stand images in `public/piece`, `public/board` and `public/stand`
come from the same ShogiHome commit and the same license.
