import packageJson from "../../../package.json" with { type: "json" };

export const rangoVersion: string = packageJson.version;

let _bannerPrinted = false;

export function printBanner(
  mode: "dev" | "build" | "preview",
  preset: string,
  version: string,
): void {
  if (_bannerPrinted) return;
  _bannerPrinted = true;

  // ANSI codes
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  const banner = `
${dim}  ✦        ✦          ✧.           .          .${reset}
${dim} ╱${reset}    ${bold}╔═╗${reset}${dim}      *      ╱                   ✦             *${reset}
${dim}      ${reset}${bold}║ ║${reset} ${bold}╔═╗${reset}${dim}                    *                ✧.   ╱${reset}
${dim}   ${reset}${bold}╔╗ ║ ║ ║ ║${reset}${dim}                          *               ╱${reset}
${dim}   ${reset}${bold}║║ ║ ║ ║ ║  ╦═╗╔═╗╔╗╔╔═╗╔═╗${reset}${dim}             ✧              ✦${reset}
${dim}  ${reset}${bold}═╣║ ║ ╠═╝ ║  ╠╦╝╠═╣║║║║ ╦║ ║${reset}${dim}        *           ✧${reset}
${dim}   ${reset}${bold}║╚═╝ ╔═══╝  ╩╚═╩ ╩╝╚╝╚═╝╚═╝${reset}${dim}            ✦          .      *${reset}
${dim}   ${reset}${bold}╚══╗ ║${reset}${dim} *      RSC Wrangler         ✧                ✦${reset}
${dim}  *   ${reset}${bold}║ ╠═${reset}${dim}                         *            ✧.    ╱${reset}
${bold}══════╝ ╚═════════╩═══${reset}${dim}                  ✦            *${reset}

   v${version} · ${preset} · ${mode}
`;

  console.log(banner);
}
