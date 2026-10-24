/**
 * The phone gateway without the desktop app, for `npm run dev`: lets a paired iPhone
 * reach the dev server. PORT is the dev server's (3000 by default).
 */
import { startPhoneGateway } from "../electron/phone-gateway";

const serverPort = Number(process.env.PORT ?? 3000);
const phonePort = Number(process.env.LOCKIN_PHONE_PORT ?? 47821);
startPhoneGateway({ serverPort, phonePort });
console.log(`phone gateway: phones → :${phonePort} → Lockin on :${serverPort} (listens once a phone is paired)`);
