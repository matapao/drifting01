export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
