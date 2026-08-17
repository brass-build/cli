// The package version the CLI reports on every data-API call (the
// `x-brass-client` header; a Node process has no CORS so a header is
// free here, unlike the SDK's query-param channel). Lets the platform
// measure the CLI version distribution, in particular pinned CI copies.
// A unit test pins this to package.json's version.
export const VERSION = '0.2.0';

export const CLI_CLIENT_ID = `cli/${VERSION}`;
