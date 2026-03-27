const resolveModelChain = (requestedModel) => {
  if (requestedModel === 'mypro' || requestedModel === 'gemini-3-mypro' || requestedModel === 'gpt-4-my') {
    return ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'];
  } else if (requestedModel === 'my' || requestedModel === 'gemini-3-my') {
    return ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
  }
  return [requestedModel];
};

module.exports = { resolveModelChain };
