// Google Cloud: credenciales (clave JSON o federacion con la identidad de Azure) y proveedor del token de acceso.
import { ExternalAccountClient, JWT, type BaseExternalAccountClient } from "google-auth-library";
import { env } from "../../config/env.js";
import { trimText } from "../shared/text-utils.js";

export type GcpKeyCredentials = {
  mode: "key";
  /** Clave JSON de la cuenta de servicio (texto JSON o base64). */
  credentialsJson: string;
};

export type GcpFederationCredentials = {
  mode: "federation";
  /** //iam.googleapis.com/projects/<numero>/locations/global/workloadIdentityPools/<pool>/providers/<proveedor> */
  audience: string;
  /** Cuenta de servicio que se impersona (la del autoencendido). */
  serviceAccountEmail: string;
  /** Audience que se le pide a la identidad administrada de Azure (p. ej. api://adaceen-gcp). */
  azureTokenResource: string;
};

export type GcpCredentials = GcpKeyCredentials | GcpFederationCredentials;

export type GcpAuthMode = GcpCredentials["mode"];

const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

const WORKLOAD_IDENTITY_AUDIENCE_RE = /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;

const SERVICE_ACCOUNT_EMAIL_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][-a-z0-9.:]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/;

type ServiceAccountKey = { client_email: string; private_key: string };

/** Lee la clave de la cuenta de servicio (JSON o base64 del JSON). */
export function parseServiceAccountJson(raw: string): ServiceAccountKey | null {
  const text = trimText(raw);
  if (!text) return null;
  const candidates = [text];
  if (!text.startsWith("{")) {
    try {
      candidates.push(Buffer.from(text, "base64").toString("utf8").trim());
    } catch {
      // no era base64
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ServiceAccountKey>;
      const clientEmail = trimText(parsed?.client_email);
      const privateKey = typeof parsed?.private_key === "string" ? parsed.private_key.replace(/\\n/g, "\n") : "";
      if (clientEmail && privateKey.includes("PRIVATE KEY")) {
        return { client_email: clientEmail, private_key: privateKey };
      }
    } catch {
      // se prueba el siguiente formato
    }
  }
  return null;
}

export type GcpCredentialsSource = {
  credentialsJson?: string;
  workloadIdentityAudience?: string;
  serviceAccountEmail?: string;
  azureTokenResource?: string;
};

/**
 * Credenciales de Google Cloud desde el entorno (pura, sin red).
 * - credentials null y problem "": no hay ninguna configurada.
 * - problem: la federacion esta pedida pero incompleta o invalida (que falta, sin valores).
 * - warning: hay clave y federacion a la vez (se usa la clave).
 */
export function resolveGcpCredentials(source: GcpCredentialsSource = {
  credentialsJson: env.gcpServiceAccountJson,
  workloadIdentityAudience: env.gcpWorkloadIdentityAudience,
  serviceAccountEmail: env.gcpServiceAccountEmail,
  azureTokenResource: env.gcpAzureTokenResource,
}): { credentials: GcpCredentials | null; problem: string; warning: string } {
  const audience = trimText(source.workloadIdentityAudience);
  const serviceAccountEmail = trimText(source.serviceAccountEmail).toLowerCase();
  const azureTokenResource = trimText(source.azureTokenResource);
  const federationRequested = Boolean(audience || serviceAccountEmail || azureTokenResource);

  if (parseServiceAccountJson(source.credentialsJson || "")) {
    return {
      credentials: { mode: "key", credentialsJson: source.credentialsJson || "" },
      problem: "",
      warning: federationRequested
        ? "GCP_SERVICE_ACCOUNT_JSON y la federacion de identidades estan las dos: se usa la clave. Borra GCP_SERVICE_ACCOUNT_JSON del App Service para pasar a la federacion (sin clave)."
        : "",
    };
  }
  if (!federationRequested) return { credentials: null, problem: "", warning: "" };

  const missing = [
    WORKLOAD_IDENTITY_AUDIENCE_RE.test(audience) ? "" : "GCP_WORKLOAD_IDENTITY_AUDIENCE",
    SERVICE_ACCOUNT_EMAIL_RE.test(serviceAccountEmail) ? "" : "GCP_SERVICE_ACCOUNT_EMAIL",
    azureTokenResource && !/\s/.test(azureTokenResource) ? "" : "GCP_AZURE_TOKEN_RESOURCE",
  ].filter(Boolean);
  if (missing.length) {
    return {
      credentials: null,
      problem: `federacion de identidades con Google Cloud incompleta: faltan o no son validas ${missing.join(", ")}.`,
      warning: "",
    };
  }
  return { credentials: { mode: "federation", audience, serviceAccountEmail, azureTokenResource }, problem: "", warning: "" };
}

export type AzureIdentityEnv = {
  /** IDENTITY_ENDPOINT: lo pone App Service en el proceso. */
  identityEndpoint?: string;
  /** IDENTITY_HEADER: secreto por proceso que exige ese endpoint. */
  identityHeader?: string;
};

/** Variables de la identidad administrada que Azure pone en el proceso (vacias fuera de App Service). */
export function readAzureIdentityEnv(source: NodeJS.ProcessEnv = process.env): AzureIdentityEnv {
  return { identityEndpoint: trimText(source.IDENTITY_ENDPOINT), identityHeader: trimText(source.IDENTITY_HEADER) };
}

export const AZURE_IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";

/**
 * Configuracion de cuenta externa (external_account) para google-auth-library, sin red:
 * la libreria pide el token de Azure a `credential_source.url` con esas cabeceras, lo
 * canjea en STS por uno federado y con ese impersona a la cuenta de servicio.
 * Con IDENTITY_ENDPOINT e IDENTITY_HEADER (App Service) usa ese endpoint; si faltan,
 * el IMDS de Azure (VM o Container Apps).
 */
export function buildFederationCredentialJson(credentials: GcpFederationCredentials, azure: AzureIdentityEnv = {}) {
  const identityEndpoint = trimText(azure.identityEndpoint);
  const identityHeader = trimText(azure.identityHeader);
  const resource = encodeURIComponent(credentials.azureTokenResource);
  const appService = Boolean(identityEndpoint && identityHeader);
  const url = appService
    ? `${identityEndpoint}${identityEndpoint.includes("?") ? "&" : "?"}api-version=2019-08-01&resource=${resource}`
    : `${AZURE_IMDS_TOKEN_URL}?api-version=2018-02-01&resource=${resource}`;
  const headers: Record<string, string> = appService ? { "X-IDENTITY-HEADER": identityHeader } : { Metadata: "true" };
  return {
    type: "external_account" as const,
    audience: credentials.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${credentials.serviceAccountEmail}:generateAccessToken`,
    credential_source: {
      url,
      headers,
      format: { type: "json" as const, subject_token_field_name: "access_token" },
    },
  };
}

/** Proveedor del token OAuth2 de Compute segun el modo de credenciales. */
export function createGcpTokenProvider(credentials: GcpCredentials, azure: AzureIdentityEnv = readAzureIdentityEnv()): () => Promise<string> {
  if (credentials.mode === "key") {
    const key = parseServiceAccountJson(credentials.credentialsJson);
    let client: JWT | null = null;
    return async () => {
      if (!key) throw new Error("clave de la cuenta de servicio invalida");
      client = client || new JWT({ email: key.client_email, key: key.private_key, scopes: [COMPUTE_SCOPE] });
      const { token } = await client.getAccessToken();
      if (!token) throw new Error("la cuenta de servicio no entrego token de acceso");
      return token;
    };
  }
  let client: BaseExternalAccountClient | null = null;
  return async () => {
    if (!client) {
      const created = ExternalAccountClient.fromJSON({ ...buildFederationCredentialJson(credentials, azure), scopes: [COMPUTE_SCOPE] });
      if (!created) throw new Error("no se pudo crear el cliente de la federacion de identidades");
      client = created;
    }
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("la federacion de identidades no entrego token de acceso");
    return token;
  };
}
