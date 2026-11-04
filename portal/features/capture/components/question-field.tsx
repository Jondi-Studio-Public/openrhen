import type { ResolvedQuestion } from "@openrhen/contracts";

/** Fields rated 1 to 5 (the actions table checks both between 1 and 5); their chips are bare numbers. */
const RATING_FIELDS = new Set(["importance", "consequence"]);
const RATING_MAX = 5;

const isRatingChip = (field: string, suggestion: string) =>
  RATING_FIELDS.has(field.split(".").pop() ?? field) && /^[1-5]$/.test(suggestion);

/**
 * One open question (the shared shape every Inbox item uses), answered inline: suggestions are chips
 * (tap one to answer, tap again to clear) and anything else is typed, or picked for a date. The item
 * cannot be confirmed until this has an answer.
 */
export function QuestionField({
  idPrefix,
  question,
  value,
  onChange
}: {
  idPrefix: string;
  question: ResolvedQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = `${idPrefix}-${question.field}`;
  const rated = question.suggestions.some((suggestion) => isRatingChip(question.field, suggestion));
  return (
    <div className="email-question" data-answered={value.trim() ? "true" : "false"}>
      <label htmlFor={inputId}>{question.question}</label>
      {question.suggestions.length > 0 && (
        <div className="email-question-chips" role="group" aria-label={`Suggested answers to ${question.question}`}>
          {question.suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className={`chip small${value === suggestion ? " selected" : ""}`}
              aria-pressed={value === suggestion}
              {...(isRatingChip(question.field, suggestion)
                ? {
                    "aria-label": `${suggestion} of ${RATING_MAX}`,
                    title: `${suggestion} on a scale of 1 to ${RATING_MAX}`
                  }
                : {})}
              onClick={() => onChange(value === suggestion ? "" : suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      {rated && <small className="microcopy">Scale 1 (low) to {RATING_MAX} (high)</small>}
      <input
        id={inputId}
        type={question.input === "datetime" ? "datetime-local" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={question.input === "datetime" ? undefined : "Type an answer"}
      />
    </div>
  );
}
