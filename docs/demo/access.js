// The dashboard's copy of the Tollwise access key. It lives only in the tab's session storage (gone when
// the tab closes) and travels only as a request header. It is never put in a URL, a query string, a
// cookie, localStorage, the page title or any log line. Pure: the storage is passed in, so this runs
// under Node's test runner with a stand-in.
/** The session-storage entry that holds the key for this tab. */
export const ACCESS_KEY_ENTRY = 'tollwise.accessKey';
/** The request header the key is sent in; Tollwise also accepts it as "Authorization: Bearer <key>". */
export const ACCESS_KEY_HEADER = 'x-api-key';
/**
 * The key as typed, trimmed; undefined when it is empty or could not be sent as a header value
 * (a control character, or anything outside visible ASCII and space, which fetch would refuse).
 */
export function normalizeAccessKey(input) {
    const key = input.trim();
    if (key === '' || !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(key))
        return undefined;
    return key;
}
/** The key stored for this tab, if any. A stored value that could not be sent is treated as none. */
export function readAccessKey(storage) {
    const stored = storage?.getItem(ACCESS_KEY_ENTRY);
    return stored === null || stored === undefined ? undefined : normalizeAccessKey(stored);
}
export function storeAccessKey(storage, key) {
    storage?.setItem(ACCESS_KEY_ENTRY, key);
}
export function forgetAccessKey(storage) {
    storage?.removeItem(ACCESS_KEY_ENTRY);
}
/** The headers of an API request: the key when there is one, and never anything else about it. */
export function apiHeaders(key, accept = 'application/json') {
    return key === undefined ? { accept } : { accept, [ACCESS_KEY_HEADER]: key };
}
