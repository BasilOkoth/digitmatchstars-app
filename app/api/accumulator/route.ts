import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const endpoint = process.env.ACCUMULATOR_CONTROL_URL || 'http://127.0.0.1:8765';
async function proxy(request: NextRequest, method: 'GET'|'POST') {
  // Never expose this API on a public deployment without authentication.
  if (process.env.ACCUMULATOR_DASHBOARD_ENABLED !== 'true') {
    return NextResponse.json({error:'Accumulator dashboard disabled. Set ACCUMULATOR_DASHBOARD_ENABLED=true on a trusted local deployment.'},{status:503});
  }
  const operation = request.nextUrl.searchParams.get('action') || 'status';
  if (!['status','start','stop'].includes(operation)) return NextResponse.json({error:'Invalid action'},{status:400});
  if (method==='GET' && operation!=='status') return NextResponse.json({error:'Method not allowed'},{status:405});
  if (method==='POST' && operation==='status') return NextResponse.json({error:'Method not allowed'},{status:405});
  try {
    const body = method==='POST' && operation==='start' ? await request.text() : undefined;
    const response = await fetch(`${endpoint}/${operation}`,{method,body,headers:body?{'Content-Type':'application/json'}:{},cache:'no-store',signal:AbortSignal.timeout(8000)});
    return new NextResponse(await response.text(),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  } catch {return NextResponse.json({error:'Accumulator control server unavailable. Start the local Python service.'},{status:502});}
}
export async function GET(req:NextRequest){return proxy(req,'GET');}
export async function POST(req:NextRequest){return proxy(req,'POST');}
