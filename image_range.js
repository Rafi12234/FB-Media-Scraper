// Shared helper: 1-based, inclusive image ordinal ranges; blank upper bound = all.
var ImageRange = Object.freeze({
  bounds(fromValue, toValue) {
    const from = fromValue == null || fromValue === "" ? 1 : Number(fromValue);
    const to = toValue == null || toValue === "" ? 0 : Number(toValue);
    if (!Number.isSafeInteger(from) || from < 1) {
      throw new Error("Image From must be a whole number starting at 1.");
    }
    if (!Number.isSafeInteger(to) || to < 0 || (to !== 0 && to < from)) {
      throw new Error("Image To must be blank or at least Image From.");
    }
    return { from, to };
  },
  select(urls, from, to) {
    const bounds = this.bounds(from, to);
    const all = Array.isArray(urls) ? urls : [];
    return all.slice(bounds.from - 1, bounds.to || undefined)
      .map((url, offset) => ({ url, index: bounds.from + offset }));
  }
});
if (typeof module !== "undefined" && module.exports) module.exports = ImageRange;
