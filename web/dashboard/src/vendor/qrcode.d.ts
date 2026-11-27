export interface QRCodeInstance {
  addData(data: string, mode?: "Numeric" | "Alphanumeric" | "Byte" | "Kanji"): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

export default function qrcode(
  typeNumber: number,
  errorCorrectionLevel: "L" | "M" | "Q" | "H",
): QRCodeInstance;
