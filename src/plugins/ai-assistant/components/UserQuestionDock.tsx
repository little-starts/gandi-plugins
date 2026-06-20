import * as React from "react";
import composer from "../ui/Composer.module.less";
import { PendingUserQuestion, UserQuestionOption } from "../types";

interface UserQuestionDockProps {
  question: PendingUserQuestion | null;
  onAnswer: (answer: string, selectedOption?: UserQuestionOption | null) => void;
  onGoBack: () => void;
}

export const UserQuestionDock: React.FC<UserQuestionDockProps> = ({ question, onAnswer, onGoBack }) => {
  const [customMode, setCustomMode] = React.useState(false);
  const [customAnswer, setCustomAnswer] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const currentQuestion = question?.questions[question.currentIndex];
  const currentAnswer = question?.answers[question.currentIndex]?.answer || "";
  const progress = question ? ((question.currentIndex + 1) / question.questions.length) * 100 : 0;

  React.useEffect(() => {
    setCustomMode(currentQuestion?.questionType === "input");
    setCustomAnswer(currentAnswer);
  }, [currentAnswer, currentQuestion?.id, currentQuestion?.questionType]);

  React.useEffect(() => {
    if (customMode) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [customMode]);

  if (!question || !currentQuestion) return null;

  const canUseCustomInput = currentQuestion.allowCustomInput !== false;

  const submitCustomAnswer = () => {
    const answer = customAnswer.trim();
    if (!answer) return;
    onAnswer(answer, null);
  };

  return (
    <div className={composer.userQuestionDock}>
      <div className={composer.userQuestionHeader}>
        <span className={composer.userQuestionBadge}>需要补充信息</span>
        <strong>{currentQuestion.question}</strong>
      </div>
      {currentQuestion.details ? <pre className={composer.userQuestionDetails}>{currentQuestion.details}</pre> : null}
      {question.questions.length > 1 ? (
        <div className={composer.userQuestionProgressBlock}>
          <div className={composer.userQuestionProgressMeta}>
            <span>{`${question.currentIndex + 1} / ${question.questions.length}`}</span>
            <span>{`${Math.round(progress)}%`}</span>
          </div>
          <div className={composer.userQuestionProgressBar}>
            <span className={composer.userQuestionProgressFill} style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}
      {currentQuestion.questionType === "choice" && currentQuestion.options.length > 0 && !customMode ? (
        <>
          <div className={composer.userQuestionOptions}>
            {currentQuestion.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={composer.userQuestionOptionButton}
                onClick={() => onAnswer(option.value, option)}
                disabled={option.disabled}
              >
                {option.label}
              </button>
            ))}
            {canUseCustomInput ? (
              <button
                type="button"
                className={`${composer.userQuestionOptionButton} ${composer.userQuestionCustomOptionButton}`}
                onClick={() => setCustomMode(true)}
              >
                {currentQuestion.customOptionLabel}
              </button>
            ) : null}
          </div>
          {question.currentIndex > 0 ? (
            <div className={composer.userQuestionInputRow}>
              <button type="button" className={composer.userQuestionSecondaryButton} onClick={onGoBack}>
                上一题
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className={composer.userQuestionInputRow}>
          <input
            ref={inputRef}
            className={composer.userQuestionInput}
            value={customAnswer}
            placeholder={currentQuestion.placeholder || "请输入补充信息..."}
            onChange={(event) => setCustomAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitCustomAnswer();
              }
              if (event.key === "Escape" && currentQuestion.options.length > 0) {
                setCustomMode(false);
              }
            }}
          />
          {currentQuestion.questionType === "choice" && currentQuestion.options.length > 0 ? (
            <button type="button" className={composer.userQuestionSecondaryButton} onClick={() => setCustomMode(false)}>
              返回选项
            </button>
          ) : null}
          {question.currentIndex > 0 ? (
            <button type="button" className={composer.userQuestionSecondaryButton} onClick={onGoBack}>
              上一题
            </button>
          ) : null}
          <button
            type="button"
            className={composer.userQuestionSubmitButton}
            onClick={submitCustomAnswer}
            disabled={!customAnswer.trim()}
          >
            提交
          </button>
        </div>
      )}
    </div>
  );
};
