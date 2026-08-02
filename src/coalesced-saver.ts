export function createCoalescedSaver(save: () => Promise<void>) {
  let dirty = false;
  let running: Promise<void> | undefined;

  const drain = async () => {
    do {
      dirty = false;
      await save();
    } while (dirty);
  };

  const schedule = () => {
    dirty = true;
    if (!running) {
      const task = drain();
      running = task;
      void task.then(
        () => {
          if (running !== task) return;
          running = undefined;
          if (dirty) schedule();
        },
        () => {
          if (running === task) running = undefined;
        },
      );
      void task.catch(() => undefined);
    }
  };

  const flush = async () => {
    if (dirty && !running) schedule();
    while (running) await running;
  };

  return { schedule, flush };
}
