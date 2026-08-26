export function chunkArray<Item>(array: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}
