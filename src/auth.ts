// How a command authenticates each request. Two kinds resolve to the same
// interface so `BrassApi` is agnostic: a service token is a static bearer;
// a login session refreshes a short-lived access token on demand (see
// `sessionAuth` in session.ts). The provider returns the exact headers to
// merge onto a data-API request.

export interface AuthProvider {
  headers(): Promise<Record<string, string>>;
}

// A service token (`brass_sk_...`) is presented verbatim as the bearer.
export function serviceTokenAuth(token: string): AuthProvider {
  return {
    headers: () => Promise.resolve({ authorization: `Bearer ${token}` }),
  };
}
