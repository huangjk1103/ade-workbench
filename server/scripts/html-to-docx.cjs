const HTMLtoDOCX = require("html-to-docx");

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks).toString("utf-8");
  const buffer = await HTMLtoDOCX(html, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });
  process.stdout.write(Buffer.from(buffer).toString("base64"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
