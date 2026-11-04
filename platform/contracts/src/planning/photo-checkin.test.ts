import { describe, expect, it } from "vitest";
import { photoCheckinEditSchema, photoCheckinMetaSchema, sniffPhotoType } from "./photo-checkin.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

describe("sniffPhotoType", () => {
  it("reads the type from the bytes, not from a name or a header", () => {
    expect(sniffPhotoType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe("image/jpeg");
    expect(sniffPhotoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffPhotoType(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe("image/webp");
    expect(sniffPhotoType(bytes(0, 0, 0, 24, ...ascii("ftypheic")))).toBe("image/heic");
  });

  it("refuses anything else, including HTML, SVG and a truncated file", () => {
    expect(sniffPhotoType(Uint8Array.from(ascii("<html><script>alert(1)</script>")))).toBeNull();
    expect(sniffPhotoType(Uint8Array.from(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBeNull();
    expect(sniffPhotoType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffPhotoType(new Uint8Array())).toBeNull();
  });
});

describe("photo check-in input", () => {
  it("needs a timestamp with an offset and defaults the transcript", () => {
    expect(photoCheckinMetaSchema.parse({ takenAt: "2026-10-02T03:00:00+10:00" }).transcript).toBe("");
    expect(photoCheckinMetaSchema.safeParse({ takenAt: "2026-10-02 03:00" }).success).toBe(false);
    expect(photoCheckinMetaSchema.safeParse({ takenAt: "2026-10-02T03:00:00Z", checkInId: "nope" }).success).toBe(
      false
    );
  });

  it("an edit carries the version it was made against", () => {
    expect(photoCheckinEditSchema.safeParse({ description: "x" }).success).toBe(false);
    expect(photoCheckinEditSchema.safeParse({ description: "x", expectedVersion: 1 }).success).toBe(true);
  });
});
