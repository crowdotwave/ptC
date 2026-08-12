// How a session felt, in the client's own words.
//
// `sessions.client_note` has been in the schema since 0001 and nothing has ever written to it: the
// logging screen hardcoded null, and so did undo. So a workout was recorded to the rep on the
// objective side and not at all on the subjective one, which for a calisthenics block is most of
// what a trainer needs. A max hold that felt easy and a max hold that nearly failed are the same
// row of numbers, and the difference between them is the whole training decision.
//
// ONE capture, at the end of the session, optional. Not per set. A prompt after every set is a
// confirmation dialog wearing different clothes, and the logging screen has none of those by
// design: it exists to make an identical set one tap. A max hold followed by "and how was that?"
// is the app taking back the thing it promised.
//
// The column is text and it stays text. A numeric session RPE would be a migration, a scale the
// client has to learn, and a number that reads as a grade. What is stored here is what a person
// would actually say, and the four words below are shortcuts for saying it rather than a scale
// with words painted on it. They are an effort ladder and not a judgement: nothing here says a
// session was bad, because "All out" is what a good week looks like as often as "Easy" is.

/** The shortcuts, hardest last. Order is the ladder, so it is also the order they are drawn in. */
export const FEELINGS = ['Easy', 'Solid', 'Hard', 'All out'];

/**
 * The note as it goes into the column: the word, the sentence, or both.
 *
 * Both is a real case and it is the interesting one. "All out. Left wrist gave out on the last
 * hold" is a trainer's next session written for them, and splitting it across two columns would
 * mean a migration to say one thing.
 *
 * Returns null rather than an empty string when there is nothing to say, because null is what the
 * column has held since it was created and an empty string is a note somebody wrote.
 */
export function composeNote(feel, text) {
  const word = FEELINGS.includes(feel) ? feel : null;
  const said = String(text ?? '').trim();
  if (word && said) return `${word}. ${said}`;
  if (word) return word;
  return said || null;
}

/**
 * The note, taken back apart, so the chips can be redrawn selected after a reload.
 *
 * The word only counts when it stands as its own sentence. "Hard to say what changed" opens with a
 * feeling and is not one, and a parser that took the prefix would light up a chip the client never
 * tapped, which is the app putting words in somebody's mouth. Anything it does not recognise, which
 * includes every note this app has ever stored, comes back whole as text.
 */
export function parseNote(note) {
  const raw = String(note ?? '').trim();
  if (!raw) return { feel: null, text: '' };

  for (const feel of FEELINGS) {
    if (raw === feel) return { feel, text: '' };
    if (raw.startsWith(`${feel}. `)) return { feel, text: raw.slice(feel.length + 2).trim() };
  }

  return { feel: null, text: raw };
}
