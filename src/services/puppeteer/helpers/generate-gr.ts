import * as QRCode from "qrcode";

export async function generateQR(data: string) {
  return QRCode.toDataURL(data, {
    width: 600,
    margin: 2
  });
}