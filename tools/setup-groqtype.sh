#!/usr/bin/env bash
# Sets up GroqType's command-line tool for NextKeyBor's dictation, without
# GroqType's own hotkey daemon (which needs root for keyd and ydotool).
# `groqtype transcribe` only needs Python's standard library.
#
#   tools/setup-groqtype.sh [API_KEY]
#
# Skips the download when a groqtype command already exists (for example a
# full GroqType install); the API key is stored in GroqType's own config.
set -euo pipefail

repo=${GROQTYPE_REPO:-https://github.com/dixonSolutions/GroqType.git}
dir="${XDG_DATA_HOME:-$HOME/.local/share}/nextkeybor/GroqType"
bin="$HOME/.local/bin/groqtype"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

groqtype=$(command -v groqtype || true)
[[ -z $groqtype && -x $bin ]] && groqtype=$bin
if [[ -z $groqtype ]]; then
    say "Downloading GroqType to $dir"
    if [[ -d $dir/.git ]]; then
        git -C "$dir" pull -q --ff-only
    else
        mkdir -p "$(dirname "$dir")"
        git clone -q --depth 1 "$repo" "$dir"
    fi
    mkdir -p "$(dirname "$bin")"
    printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$dir/groqtype.py" > "$bin"
    chmod +x "$bin"
    groqtype=$bin
fi

if ! "$groqtype" transcribe --help > /dev/null 2>&1; then
    echo "This GroqType has no 'transcribe' command yet (it comes with dixonSolutions/GroqType#8)." >&2
    echo "Dictation keeps using the local model until GroqType is updated." >&2
fi

if [[ -n ${1:-} ]]; then
    "$groqtype" config api-key "$1" > /dev/null
    say "Groq API key saved in GroqType's config"
else
    echo "Add a Groq API key (free at https://console.groq.com/keys) in NextKeyBor's settings, or run:"
    echo "  $groqtype config api-key YOUR_KEY"
fi
