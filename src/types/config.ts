export interface WebApiConfig {
  BASE_PATH?: string;
  bili_api?: string;
  netease_api?: string;
  qqmusic_api?: string;
  [key: string]: unknown;
}

export interface RuntimeYamlConfig {
  access_key_id?: string;
  access_key_secred?: string;
  web_server_host?: string;
  web_server_port?: string | number;
  [key: string]: unknown;
}

export interface VersionConfig {
  productVersion: string;
  buildId: string;
}

export interface RuntimeConfig extends VersionConfig {
  rootDir: string;
  config: RuntimeYamlConfig;
  webapi: WebApiConfig;
  host: string;
  port: number;
  basePath: string;
}
