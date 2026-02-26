import { net } from 'electron';
import { OrgUsageReport } from '../shared/types';

const BASE_URL = 'https://api.anthropic.com';

interface ApiRequestOptions {
  apiKey: string;
  path: string;
  method?: string;
}

function apiRequest<T>(options: ApiRequestOptions): Promise<T> {
  const { apiKey, path, method = 'GET' } = options;

  return new Promise((resolve, reject) => {
    const request = net.request({
      url: `${BASE_URL}${path}`,
      method,
    });

    request.setHeader('x-api-key', apiKey);
    request.setHeader('anthropic-version', '2023-06-01');
    request.setHeader('Content-Type', 'application/json');

    let responseData = '';

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        responseData += chunk.toString();
      });

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            resolve(JSON.parse(responseData) as T);
          } catch (err: any) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        } else {
          reject(new Error(`API error ${response.statusCode}: ${responseData}`));
        }
      });
    });

    request.on('error', (err) => {
      reject(new Error(`Network error: ${err.message}`));
    });

    request.end();
  });
}

export async function testApiConnection(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Use a lightweight endpoint to verify the key works
    await apiRequest({
      apiKey,
      path: '/v1/messages',
      method: 'POST',
    });
    // If we get here without auth error, key is valid
    return { success: true };
  } catch (err: any) {
    const msg = err.message || '';
    // A 400 (bad request) still means auth passed — the key is valid
    if (msg.includes('400')) {
      return { success: true };
    }
    // 401/403 means bad key
    if (msg.includes('401') || msg.includes('403')) {
      return { success: false, error: 'Invalid API key' };
    }
    return { success: false, error: msg };
  }
}

export async function fetchOrgUsage(
  apiKey: string,
  period?: string
): Promise<OrgUsageReport | { error: string }> {
  try {
    const queryParams = period ? `?period=${encodeURIComponent(period)}` : '';
    const data = await apiRequest<any>({
      apiKey,
      path: `/v1/organizations/usage${queryParams}`,
    });

    return {
      period: data.period || period || 'current',
      total_cost_usd: data.total_cost_usd || 0,
      total_input_tokens: data.total_input_tokens || 0,
      total_output_tokens: data.total_output_tokens || 0,
      models: data.models || [],
    };
  } catch (err: any) {
    return { error: err.message || 'Failed to fetch usage' };
  }
}
