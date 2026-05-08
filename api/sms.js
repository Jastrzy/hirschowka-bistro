export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ok:false, err:'Method not allowed'});

  const { token, to, message, sender } = req.body || {};
  if (!token || !to || !message) {
    return res.status(400).json({ok:false, err:'Brak: token, to, message'});
  }

  try {
    const body = new URLSearchParams();
    body.append('access_token', token);
    body.append('to', to);
    body.append('message', message);
    body.append('from', sender || 'Hirschowka');
    body.append('format', 'json');
    body.append('encoding', 'utf-8');

    const response = await fetch('https://api.smsapi.pl/sms.do', {
      method: 'POST',
      body: body,
    });
    const data = await response.json();
    if (data.error) return res.status(200).json({ok:false, err:String(data.error)});
    return res.status(200).json({ok:true});
  } catch(e) {
    return res.status(500).json({ok:false, err:e.message});
  }
}
