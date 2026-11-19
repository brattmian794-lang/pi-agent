export function shouldShowBrowserSlot(
  slotActive: boolean,
  width: number,
  height: number,
  alertDialogOpen: boolean,
): boolean {
  return slotActive && !alertDialogOpen && width > 4 && height > 4
}
