# ADR 0002: Separate Cognito user pools for users and admins

- Status: Accepted
- Date: 2026-10-25

## Context

The platform spec asks for "Amazon Cognito; Google and LINE Login as OIDC providers; MFA for
admins", an admin app on its own subdomain, and roles (`photographer`, `user`, `admin`) in the
`users` table. It doesn't say how many user pools to use. Wave 1 infra created two, which is a
deviation that needs a record.

- Cognito configures MFA per user pool (`OFF`, `OPTIONAL` or `ON`). It can't require MFA for one
  group inside a pool.
- Cognito MFA doesn't apply to federated sign-ins. Google and LINE users authenticate at their
  provider, so a pool with MFA `ON` would still let them in without a second factor.
- Viewers must be able to sign in with LINE or Google in one step when a share requires login.
  Forcing them to enrol a TOTP app would break face search on phones.
- Admins can read every tenant's data and take down files and shares. Their accounts must never
  come from self sign-up or from a social login.

## Decision

1. Two user pools in the Auth stack (`infra/lib/stacks/auth-stack.ts`):
   - `shotx-<stage>-users`: photographers and viewers. Self sign-up, email and password, Google
     and LINE (OIDC). TOTP MFA optional. App client `shotx-<stage>-web` for the main domain.
   - `shotx-<stage>-admins`: admins only. No self sign-up (accounts are created by an operator),
     no federation, TOTP MFA required, stricter password policy, 12-hour refresh tokens. App
     client `shotx-<stage>-admin` for the admin domain.
2. The API trusts tokens from both pools and tells them apart by issuer:
   - users pool: `https://cognito-idp.ap-southeast-1.amazonaws.com/<COGNITO_USER_POOL_ID>`
   - admins pool: `https://cognito-idp.ap-southeast-1.amazonaws.com/<COGNITO_ADMIN_USER_POOL_ID>`
3. A token from the users pool never gets the `admin` role, whatever the `users` row, the
   `cognito:groups` claim or any other claim says. The `admin` role comes only from a valid
   admins-pool token, and an admins-pool token never acts as a photographer or viewer.
4. Users are identified by the pair (issuer, `sub`). `sub` alone and email are not identities.

## Rationale

- MFA for admins is enforced by Cognito itself (`MfaConfiguration: ON`, asserted by an infra
  test), not by application code that could be bypassed or regress.
- Federation is impossible in the admins pool, so a LINE or Google account can't become an admin
  through misconfigured attribute mapping or account linking.
- Viewers keep a one-step social sign-in.
- The admin app already has its own subdomain, distribution and web ACL; its own pool (with its
  own hosted UI domain) keeps the whole admin path separate.

## Alternatives considered

- **One pool, MFA optional, admins in a Cognito group, MFA checked in the API.** Rejected: the
  API can't see from a Cognito token whether MFA was used, so enforcement would need custom
  triggers. Admin accounts would also share a pool with self sign-up and federation.
- **One pool, MFA required for everyone.** Rejected: viewers would have to enrol TOTP, and
  federated users skip Cognito MFA anyway.
- **Cognito Plus plan with risk-based (adaptive) authentication.** Rejected: it asks for MFA when
  a sign-in looks risky, which isn't the same as always requiring it, and it costs more per
  user.

## Consequences

- api must verify each token against the JWKS of its own issuer, check `token_use`, and check the
  app client (`aud` for ID tokens, `client_id` for access tokens) of that pool. Tokens with any
  other issuer are rejected.
- api gets both pools' settings: `COGNITO_USER_POOL_ID`, `COGNITO_WEB_CLIENT_ID`,
  `COGNITO_DOMAIN`, `COGNITO_ADMIN_USER_POOL_ID`, `COGNITO_ADMIN_CLIENT_ID`,
  `COGNITO_ADMIN_DOMAIN`. web gets only the users pool, admin only the admins pool.
- Admin endpoints (`/admin/*`) require an admins-pool token; every other authenticated endpoint
  requires a users-pool token. The guard decides this in one place.
- The data model needs the issuer (or pool) next to `cognito_sub`, unique as a pair. The same
  email can exist in both pools and must not merge accounts. contracts owns this change in
  packages/db.
- Signing in with LINE and with Google creates two users-pool users with different `sub`s.
  Linking them (Cognito `AdminLinkProviderForUser` or an app-level link) is a separate decision.
- Admin accounts are created by an operator (console or `AdminCreateUser`); there is no sign-up
  page. Lost MFA devices are reset by another admin or an operator.
