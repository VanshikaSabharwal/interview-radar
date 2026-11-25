import assert from "node:assert/strict";
import { test } from "node:test";
import { formatProfile } from "../src/bot.js";
import type { Profile } from "../src/profile.js";
import { checkResumeFile, pdfToText, UserFacingError } from "../src/resume.js";

/** Build a tiny one-page PDF containing `lines` of text (enough to test extraction). */
function makePdf(lines: string[]): Uint8Array {
  const stream = `BT /F1 11 Tf 50 750 Td 14 TL ${lines.map((l) => `(${l}) '`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test("checkResumeFile accepts small PDFs only", () => {
  assert.equal(checkResumeFile({ mime_type: "application/pdf", file_size: 200_000 }), null);
  assert.match(checkResumeFile({ mime_type: "image/png", file_size: 1000 })!, /PDF/);
  assert.match(checkResumeFile({ mime_type: "application/pdf", file_size: 9_000_000 })!, /5 MB/);
});

test("pdfToText extracts text from a real PDF", async () => {
  const text = await pdfToText(
    makePdf([
      "Asha Verma - asha@example.com",
      "B.Tech Computer Science, Example Institute of Technology, 2027",
      "Skills: React, TypeScript, Node.js, PostgreSQL, Tailwind CSS",
    ]),
  );
  assert.match(text, /Asha Verma/);
  assert.match(text, /TypeScript/);
});

test("pdfToText rejects PDFs with almost no text (e.g. scans)", async () => {
  await assert.rejects(pdfToText(makePdf(["hi"])), UserFacingError);
});

test("formatProfile shows missing fields and escapes HTML", () => {
  const profile: Profile = {
    name: "Asha <Verma>",
    email: null,
    phone: null,
    city: "Bengaluru",
    headline: "Final-year CS student",
    education: [{ institution: "Example Institute", degree: "B.Tech", field: "CS", graduationYear: 2027, grade: null }],
    skills: ["React", "TypeScript"],
    experience: [],
    projects: [],
    links: { linkedin: null, github: null, portfolio: null },
    targetRoles: ["frontend developer intern"],
    preferredLocations: ["Bengaluru, Karnataka, India", "remote"],
  };
  const text = formatProfile(profile);
  assert.match(text, /Asha &lt;Verma&gt;/);
  assert.match(text, /📧 <i>not found<\/i>/);
  assert.match(text, /B\.Tech, CS @ Example Institute \(2027\)/);
  assert.match(text, /frontend developer intern/);
});
