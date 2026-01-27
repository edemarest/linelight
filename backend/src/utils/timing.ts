type TimingMarks = Record<string, number>;

export const createTimings = () => {
  const start = Date.now();
  const marks: TimingMarks = {};

  const mark = (label: string) => {
    marks[label] = Date.now() - start;
  };

  const totalMs = () => Date.now() - start;

  return {
    mark,
    totalMs,
    marks,
  };
};
