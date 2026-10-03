// Subset of ShogiHome src/common/settings/app.ts (MIT, (c) 2022 Kubo Ryosuke): only the enums BoardView needs.
export enum KingPieceType {
  GYOKU_AND_OSHO = "gyokuAndOsho",
  GYOKU_AND_GYOKU = "gyokuAndGyoku",
}

export enum BoardImageType {
  LIGHT = "light",
  LIGHT2 = "light2",
  LIGHT3 = "light3",
  WARM = "warm",
  WARM2 = "warm2",
  RESIN = "resin",
  RESIN2 = "resin2",
  RESIN3 = "resin3",
  GREEN = "green",
  CHERRY_BLOSSOM = "cherry-blossom",
  AUTUMN = "autumn",
  SNOW = "snow",
  DARK_GREEN = "dark-green",
  DARK = "dark",
  CUSTOM_COLOR = "custom-color",
  CUSTOM_IMAGE = "custom-image",
}

export enum PieceStandImageType {
  STANDARD = "standard",
  DARK_WOOD = "dark-wood",
  GREEN = "green",
  CHERRY_BLOSSOM = "cherry-blossom",
  AUTUMN = "autumn",
  SNOW = "snow",
  DARK_GREEN = "dark-green",
  DARK = "dark",
  CUSTOM_COLOR = "custom-color",
  CUSTOM_IMAGE = "custom-image",
}

export enum HandPieceOrder {
  STRONGER_TO_LEFT = "strongerToLeft", // 飛・金・桂が左（実物の慣習に近い）
  STRONGER_TO_RIGHT = "strongerToRight", // 飛・金・桂が右
}

export enum PromotionSelectorStyle {
  HORIZONTAL = "horizontal",
  VERTICAL_PREFER_BOTTOM = "verticalPreferBottom",
  HORIZONTAL_PREFER_RIGHT = "horizontalPreferRight",
}

export enum BoardLabelType {
  NONE = "none",
  STANDARD = "standard",
}

