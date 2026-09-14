import type { Config } from "../../config.ts";

/**
 * Mirrors `rest/model/RestAppConfig.java`.
 *
 * The Java class is `@JsonAutoDetect(fieldVisibility = NONE, getterVisibility =
 * PUBLIC_ONLY, isGetterVisibility = PUBLIC_ONLY)` plus `@JsonInclude(NON_NULL)`,
 * so the wire contract is: every getter name, with null-valued strings omitted
 * entirely rather than serialised as null. Both properties are reproduced here.
 *
 * Note `recaptcha2*` -- the JSON keys say "recaptcha2" while the configuration
 * keys say "captcha". Do not let that rename slip.
 */
export interface RestAppConfig {
  apiBaseUrl: string;
  uiBaseUrl: string;
  googleOauth2Url?: string;
  googleOauth2Enabled: boolean;
  facebookOauth2Url?: string;
  facebookOauth2Enabled: boolean;
  registrationEnabled: boolean;
  recaptcha2Enabled: boolean;
  recaptcha2SiteKey?: string;
  analyticsAccount?: string;
  jwtExpirationMin: number;
}

/**
 * Takes `Config` as an explicit parameter -- not the Bun-only
 * `config.bun.ts` singleton -- so this function works unmodified on both
 * the Bun entrypoint (`http/routes/app.ts`, passing `config.bun.ts`'s
 * value) and the Cloudflare Workers skeleton (`workers.ts`, passing a
 * `buildConfig(c.env)` result).
 */
export function buildAppConfig(config: Config): RestAppConfig {
  const googleEnabled =
    config.googleOauthEnabled && config.googleClientId !== "";

  const result: RestAppConfig = {
    apiBaseUrl: config.apiBaseUrl,
    uiBaseUrl: config.uiBaseUrl,
    googleOauth2Enabled: googleEnabled,
    facebookOauth2Enabled: false,
    registrationEnabled: config.registrationEnabled,
    recaptcha2Enabled: config.captchaEnabled,
    jwtExpirationMin: config.jwtExpirationMin,
  };

  if (googleEnabled) {
    result.googleOauth2Url = `${config.apiBaseUrl}/api/restful/oauth2/google/authorize`;
  }

  // @JsonInclude(NON_NULL): omit rather than emit null/empty.
  if (config.captchaSiteKey !== "")
    result.recaptcha2SiteKey = config.captchaSiteKey;
  if (config.analyticsAccount !== "")
    result.analyticsAccount = config.analyticsAccount;

  return result;
}
