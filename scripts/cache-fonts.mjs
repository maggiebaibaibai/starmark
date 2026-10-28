import { mkdir, writeFile } from "node:fs/promises";
const root = new URL("../.cache/fonts/", import.meta.url);
await mkdir(root, { recursive: true });
const url =
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+JP:wght@400&family=Space+Grotesk:wght@400;500;600&display=swap";
const response = await fetch(url, {
  headers: { "User-Agent": "Starmark font cache" },
});
if (!response.ok) throw new Error(`Google Fonts: ${response.status}`);
let css = await response.text();
for (const [index, match] of [
  ...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g),
].entries()) {
  const font = await fetch(match[1]);
  if (!font.ok) throw new Error(`Font: ${font.status}`);
  const name = `font-${index}.${match[1].endsWith(".ttf") ? "ttf" : "woff2"}`;
  await writeFile(new URL(name, root), Buffer.from(await font.arrayBuffer()));
  css = css.replace(match[1], `/fonts/${name}`);
}
await writeFile(new URL("fonts.css", root), css);
console.log("Google Fonts cached locally for OBS and PNG exports.");
