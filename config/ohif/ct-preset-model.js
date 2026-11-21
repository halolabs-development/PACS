
function kinApplyCTPreset(services, commands, presetIndex) {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  const id = services.viewportGridService.getActiveViewportId();
  const grid = services.viewportGridService.getState().viewports.get(id);
  const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const ids = grid?.displaySetInstanceUIDs || [];
  const displaySet = ids.length === 1 && services.displaySetService.getDisplaySetByUID(ids[0]);
  const preset = Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < 5 &&
    services.customizationService.get('cornerstone.windowLevelPresets')?.presets?.CT?.[presetIndex];
  const validNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value));
  if (viewport?.type !== 'stack' || displaySet?.Modality !== 'CT' || displaySet?.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' ||
      !preset || !validNumber(preset.window) || Number(preset.window) <= 0 || !validNumber(preset.level)) {
    services.uiNotificationService.show({ title: kinText("CT 표시 프리셋"), message: kinText("일반 CT 영상을 선택하고 프리셋 설정을 확인하세요."), type: 'info' });
    return false;
  }
  commands.runCommand('setViewportWindowLevel', { viewportId: id, window: Number(preset.window), level: Number(preset.level) }, 'CORNERSTONE');
  return true;
}
