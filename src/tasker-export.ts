import { readFile } from 'node:fs/promises';
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export async function generateTaskerProject(
  publicUrl: string,
  apiKey: string,
  templatePath = 'tasker/Actual_SMS_Inbox.prj.xml',
) {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Tasker requires an HTTPS service URL');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Enter the service origin without a path, credentials or query');
  let source = await readFile(templatePath, 'utf8');
  source = source
    .replaceAll('%ActualSmsServiceUrl/v1/', '%ActualSmsServiceUrl/api/v1/')
    .replaceAll('Actual SMS Inbox To Budget', 'sms2actual')
    .replaceAll('Actual SMS Inbox Sync', 'sms2actual · Inbox sync');
  let index = 0;
  source = source.replace(
    /<exportval><\/exportval>/g,
    () => `<exportval>${xml(index++ === 0 ? apiKey : url.origin)}</exportval>`,
  );
  return source;
}
