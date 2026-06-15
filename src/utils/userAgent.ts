export interface ParsedUA {
  device: string;
  os: string;
  client: string;
}

export function parseUserAgent(ua: string): ParsedUA {
  if (!ua) return { device: '—', os: '—', client: '—' };

  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const device = isMobile ? 'Моб.' : 'Десктоп';

  let os = '—';
  if (/iPhone|iPod/.test(ua)) os = 'iOS';
  else if (/iPad/.test(ua)) os = 'iPadOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  let client = '—';
  if (/Googlebot|YandexBot|bingbot|DomainCrawler|Uptimebot|check_http|MSRBOT/i.test(ua)) client = 'Бот';
  else if (/Outlook/i.test(ua)) client = 'Outlook';
  else if (/Thunderbird/i.test(ua)) client = 'Thunderbird';
  else if (/Apple\s?Mail|AppleMail/i.test(ua)) client = 'Apple Mail';
  else if (/YahooMail/i.test(ua)) client = 'Yahoo Mail';
  else if (/Gmail/i.test(ua)) client = 'Gmail';
  else if (/The Bat!/i.test(ua)) client = 'The Bat!';
  else if (/Lotus[- ]Notes/i.test(ua)) client = 'Lotus Notes';
  else if (/Mutt/i.test(ua)) client = 'Mutt';
  else if (/SamsungBrowser/i.test(ua)) client = 'Samsung';
  else if (/EdgA?\/|Edg\//i.test(ua)) client = 'Edge';
  else if (/YaBrowser/i.test(ua)) client = 'Яндекс';
  else if (/OPR|Opera/i.test(ua)) client = 'Opera';
  else if (/Firefox/i.test(ua)) client = 'Firefox';
  else if (/Chrome/i.test(ua)) client = 'Chrome';
  else if (/Safari/i.test(ua)) client = 'Safari';

  return { device, os, client };
}
