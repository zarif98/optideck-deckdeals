/*
 * Test-only stand-in for decky-frontend-lib.
 *
 * The real module reaches into Steam's webpack internals at import time and
 * cannot load outside the Steam client. Vitest aliases the package to this
 * file (see vitest.config.ts) so services that navigate the Steam UI stay
 * testable. Calls are recorded so tests can assert where a toast would take
 * the user.
 */

export interface NavCall {
    method: string;
    arg?: string;
}

export const navCalls: NavCall[] = [];

export function resetNavCalls() {
    navCalls.length = 0;
}

export const Navigation = {
    NavigateToSteamWeb: (url: string) => { navCalls.push({ method: "NavigateToSteamWeb", arg: url }); },
    CloseSideMenus: () => { navCalls.push({ method: "CloseSideMenus" }); },
};
