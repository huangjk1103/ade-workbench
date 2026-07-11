const HTMLtoDOCX = require("html-to-docx");
const fs = require("fs");
const mammoth = require("mammoth");

(async () => {
  const tests = [
    ["<p><b>Bold</b></p>", "bold"],
    ["<p><span style=\"font-size: 24px;\">Big</span></p>", "span-size"],
    ["<p><font size=\"7\">Big2</font></p>", "font-size"],
    ["<h1>Heading</h1>", "h1"],
    ["<p style=\"font-family: SimSun;\">P style font</p>", "p-style-font"],
    ["<p><span style=\"font-family: SimSun;\">Span font</span></p>", "span-font"],
    ["<p><font face=\"SimSun\">Font face</font></p>", "font-face"],
  ];
  for (const [html, name] of tests) {
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    try {
      const buf = await HTMLtoDOCX(full, null, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true });
      fs.writeFileSync(`D:/hermes/_tmp_${name}.docx`, Buffer.from(buf));
      const result = await mammoth.convertToHtml({ buffer: fs.readFileSync(`D:/hermes/_tmp_${name}.docx`) });
      console.log(name, "->", result.value);
    } catch (e) {
      console.log(name, "ERR", e.message);
    }
  }
})();
