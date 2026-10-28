const base = process.env.STARMARK_URL || "http://localhost:3000";
const post = async (path, data = {}) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
};
const state = await (await fetch(base + "/api/state")).json();
if (state.active)
  throw new Error(
    "End the active stream in the dashboard before running the demo.",
  );
await post("/api/mock/start", { title: "no hints, final boss" });
const marks = [
  [640, "miso_", "first raid of the night", 3],
  [1720, "kettle.exe", "that dodge??", 7],
  [2980, "ana_lune", "cat walked on the keyboard", 11],
  [4105, "pixelbreak", "clutch 1v3", 16],
  [5300, "hoshi", "やっと勝った", 8],
  [6420, "luma", "he finally beat the boss", 21],
  [7790, "ttiny", "new personal best", 4],
  [9100, "marigold", "raid out", 12],
];
let elapsed = 0;
for (const [index, [offset, name, reason, count]] of marks.entries()) {
  await post("/api/mock/advance", { ms: (offset - elapsed) * 1000 });
  await post("/api/mock/chat", { name, text: "!star " + reason });
  for (let j = 1; j < count; j++)
    await post("/api/mock/chat", { name: `join${index}_${j}`, text: "!star" });
  await post("/api/mock/advance", { ms: 15000 });
  elapsed = offset + 15;
}
await post("/api/mock/advance", { ms: (9600 - elapsed) * 1000 });
const result = await post("/api/mock/end");
console.log(
  `8 stars · 82 lighters\nCard: ${base}${result.cardUrl}\nPNG:  ${base}${result.pngUrl}\nCold open: ${base}/coldopen?play=1`,
);
