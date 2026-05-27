export function createTokenBudget(totalBudget) {
  let used = 0;

  function getRemaining() {
    return totalBudget - used;
  }

  function getPercent() {
    if (totalBudget <= 0) {
      return used > 0 ? 100 : 0;
    }

    return (used / totalBudget) * 100;
  }

  function isNearLimit() {
    return getPercent() >= 70;
  }

  function isExhausted() {
    return getPercent() >= 100;
  }

  return {
    add(tokens) {
      if (!Number.isFinite(tokens)) {
        return used;
      }

      used += tokens;
      return used;
    },

    getUsed() {
      return used;
    },

    getRemaining,

    getPercent,

    isNearLimit,

    isExhausted,

    reset() {
      used = 0;
    },

    summary() {
      return {
        used,
        remaining: getRemaining(),
        total: totalBudget,
        percent: getPercent(),
        nearLimit: isNearLimit(),
        exhausted: isExhausted(),
      };
    },
  };
}
