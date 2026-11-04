/**
 * What a file says about itself rather than about any one row: a column header the importer does not
 * know, a sheet it never looked at, a row with more cells than the header row has columns. None of
 * them stop an import — every one of them describes something that was silently ignored — so they
 * are reported beside the panel the file was chosen in, as warnings, and never block a commit.
 *
 * A misspelt header is the common case and the invisible one: `expected_minute` is not read, and the
 * row then fails with "expectedMinutes is required" pointing at a column the author believes they
 * filled. Each unknown header is therefore offered its nearest known name.
 */

/** Levenshtein distance between two short strings. */
export function editDistance(first: string, second: string): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1)
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (first[row - 1] === second[column - 1] ? 0 : 1)
      );
    previous = current;
  }
  return previous[second.length]!;
}

/**
 * The known name a typo most likely meant, or null when nothing is close enough to be worth
 * suggesting. The tolerance grows with the name's length — one edit in `name`, three in
 * `transition_after_minutes` — so short names are not matched to each other by accident.
 */
export function nearestName(name: string, known: readonly string[]): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(1, Math.min(3, Math.floor(candidate.length / 4))) && (!best || distance < best.distance))
      best = { name: candidate, distance };
  }
  return best?.name ?? null;
}

const suggestion = (name: string, known: readonly string[]) => {
  const nearest = nearestName(name, known);
  return nearest ? ` Did you mean "${nearest}"?` : "";
};

/** Headers the file carries that the importer has no column for. Blank headers are not reported. */
export function headerDiagnostics(sheet: string, headers: readonly string[], known: readonly string[]): string[] {
  return [...new Set(headers.filter((header) => header && !known.includes(header)))].map(
    (header) => `${sheet}: the column "${header}" is not an import column and was ignored.${suggestion(header, known)}`
  );
}

/**
 * Rows whose shape disagrees with the header row. A row with values past the last header loses
 * them, so each such row is named; a row that simply stops early only reads blank, so those are
 * counted rather than listed.
 */
export function raggedRowDiagnostics(
  sheet: string,
  headerCount: number,
  rows: readonly { cells: readonly string[]; row: number }[]
): string[] {
  const overflowing = rows.filter(({ cells }) => cells.slice(headerCount).some((cell) => cell.trim()));
  const short = rows.filter(({ cells }) => cells.length < headerCount).length;
  const named = overflowing.slice(0, 3);
  return [
    ...named.map(
      ({ cells, row }) =>
        `${sheet}: row ${row} has ${cells.length} cells but the header row has ${headerCount}; the extra values were ignored.`
    ),
    ...(overflowing.length > named.length
      ? [`${sheet}: ${overflowing.length - named.length} further rows have values past the last header column.`]
      : []),
    ...(short
      ? [
          `${sheet}: ${short} row${short === 1 ? "" : "s"} stop${short === 1 ? "s" : ""} before the last header column; the missing cells were read as blank.`
        ]
      : [])
  ];
}

/** Sheets in a workbook nothing read. A near-miss on an import sheet's name is the interesting one. */
export function sheetDiagnostics(present: readonly string[], read: readonly string[], known: readonly string[]) {
  return present
    .filter(
      (name) => !read.includes(name) && name !== "Instructions" && !/^reference/i.test(name) && !/^guide/i.test(name)
    )
    .map((name) => `The sheet "${name}" is not an import sheet and was ignored.${suggestion(name, known)}`);
}
