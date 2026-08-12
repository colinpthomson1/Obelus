#!/bin/bash

set -euo pipefail

runtime_log() {
    local message="$1"
    printf '[Obelus] %s\n' "${message}" >&2
}

runtime_error() {
    runtime_log "ERROR: $1"
    exit 127
}

runtime_canonicalize_existing_path() {
    local target="$1"
    local link_target
    local link_count=0
    local target_directory

    while [ -L "${target}" ]; do
        link_count=$((link_count + 1))
        if [ "${link_count}" -gt 40 ]; then
            return 1
        fi

        link_target="$(readlink "${target}")" || return 1
        case "${link_target}" in
            /*) target="${link_target}" ;;
            *) target="$(dirname "${target}")/${link_target}" ;;
        esac
    done

    [ -e "${target}" ] || return 1
    target_directory="$(cd -P "$(dirname "${target}")" 2>/dev/null && pwd)" || return 1
    printf '%s/%s\n' "${target_directory}" "$(basename "${target}")"
}

runtime_path_without_shim() {
    local remaining="${PATH:-}"
    local entry
    local resolved_entry
    local result=""
    local final_entry=false

    while :; do
        case "${remaining}" in
            *:*)
                entry="${remaining%%:*}"
                remaining="${remaining#*:}"
                ;;
            *)
                entry="${remaining}"
                final_entry=true
                ;;
        esac

        case "${entry}" in
            /*)
                if resolved_entry="$(cd -P "${entry}" 2>/dev/null && pwd)"; then
                    if [ "${resolved_entry}" != "${RUNTIME_SHIM_DIRECTORY}" ]; then
                        if [ -n "${result}" ]; then
                            result="${result}:${resolved_entry}"
                        else
                            result="${resolved_entry}"
                        fi
                    fi
                fi
                ;;
        esac

        if [ "${final_entry}" = true ]; then
            break
        fi
    done

    printf '%s' "${result}"
}

runtime_resolve_candidate() {
    local runtime_name="$1"
    local candidate_spec="$2"
    local candidate
    local candidate_directory
    local candidate_absolute
    local candidate_canonical

    case "${candidate_spec}" in
        */*) candidate="${candidate_spec}" ;;
        *)
            [ -n "${RUNTIME_SAFE_PATH}" ] || return 1
            candidate="$(PATH="${RUNTIME_SAFE_PATH}" type -P -- "${candidate_spec}" 2>/dev/null)" || return 1
            ;;
    esac

    [ -f "${candidate}" ] && [ -x "${candidate}" ] || return 1
    candidate_directory="$(cd -P "$(dirname "${candidate}")" 2>/dev/null && pwd)" || return 1
    candidate_absolute="${candidate_directory}/$(basename "${candidate}")"
    candidate_canonical="$(runtime_canonicalize_existing_path "${candidate_absolute}")" || return 1

    if [ "${candidate_canonical}" = "${RUNTIME_SHIM_CANONICAL}" ]; then
        runtime_error "${runtime_name} resolves to the Obelus shim itself. Configure a different installed binary."
    fi

    printf '%s\n' "${candidate_absolute}"
}

runtime_resolve_binary() {
    local runtime_name="$1"
    local obelus_variable="$2"
    local legacy_variable="$3"
    local recursion_guard="$4"
    local candidate_spec
    local candidate_source
    local resolved_candidate
    local resolve_status

    if [ -n "${!recursion_guard:-}" ]; then
        runtime_error "Recursive ${runtime_name} shim invocation detected."
    fi

    if [ -n "${!obelus_variable:-}" ]; then
        candidate_spec="${!obelus_variable}"
        candidate_source="${obelus_variable}"
    elif [ -n "${!legacy_variable:-}" ]; then
        candidate_spec="${!legacy_variable}"
        candidate_source="${legacy_variable}"
        runtime_log "${legacy_variable} is a compatibility alias; prefer ${obelus_variable}."
    else
        candidate_spec="${runtime_name}"
        candidate_source="PATH"
    fi

    if resolved_candidate="$(runtime_resolve_candidate "${runtime_name}" "${candidate_spec}")"; then
        :
    else
        resolve_status=$?
        if [ "${resolve_status}" -eq 127 ]; then
            return 127
        fi
        runtime_error "No safe ${runtime_name} executable was found via ${candidate_source}. Install it and set ${obelus_variable} to its executable path. Obelus does not download runtimes at launch."
    fi

    runtime_log "Using installed ${runtime_name} executable resolved via ${candidate_source}."
    printf '%s\n' "${resolved_candidate}"
}

runtime_configure_node_environment() {
    local registry=""
    local certificate=""
    local certificate_canonical

    if [ -n "${OBELUS_NPM_REGISTRY:-}" ]; then
        registry="${OBELUS_NPM_REGISTRY}"
    elif [ -n "${GOOSE_NPM_REGISTRY:-}" ]; then
        registry="${GOOSE_NPM_REGISTRY}"
        runtime_log "GOOSE_NPM_REGISTRY is a compatibility alias; prefer OBELUS_NPM_REGISTRY."
    fi

    if [ -n "${registry}" ]; then
        export NPM_CONFIG_REGISTRY="${registry}"
        runtime_log "Using the explicitly configured npm registry."
    fi

    if [ -n "${OBELUS_NPM_CERT_PATH:-}" ]; then
        certificate="${OBELUS_NPM_CERT_PATH}"
    elif [ -n "${OBELUS_NPM_CERT:-}" ]; then
        certificate="${OBELUS_NPM_CERT}"
    elif [ -n "${GOOSE_NPM_CERT_PATH:-}" ]; then
        certificate="${GOOSE_NPM_CERT_PATH}"
        runtime_log "GOOSE_NPM_CERT_PATH is a compatibility alias; prefer OBELUS_NPM_CERT_PATH."
    elif [ -n "${GOOSE_NPM_CERT:-}" ]; then
        certificate="${GOOSE_NPM_CERT}"
        runtime_log "GOOSE_NPM_CERT is a compatibility alias; prefer OBELUS_NPM_CERT_PATH."
    fi

    if [ -n "${certificate}" ]; then
        case "${certificate}" in
            http://*|https://*)
                runtime_error "Remote npm certificates are not downloaded. Save the certificate locally and set OBELUS_NPM_CERT_PATH to that file."
                ;;
        esac

        [ -f "${certificate}" ] && [ -r "${certificate}" ] || runtime_error "The configured npm certificate is not a readable local file."
        certificate_canonical="$(runtime_canonicalize_existing_path "${certificate}")" || runtime_error "The configured npm certificate path could not be resolved."
        export NODE_EXTRA_CA_CERTS="${certificate_canonical}"
        runtime_log "Using the explicitly configured local npm certificate."
    fi
}

runtime_exec() {
    local runtime_name="$1"
    local runtime_binary="$2"
    local recursion_guard="$3"
    local runtime_directory
    shift 3

    runtime_directory="$(cd -P "$(dirname "${runtime_binary}")" && pwd)"
    if [ -n "${RUNTIME_SAFE_PATH}" ]; then
        export PATH="${runtime_directory}:${RUNTIME_SAFE_PATH}"
    else
        export PATH="${runtime_directory}"
    fi
    export "${recursion_guard}=1"
    runtime_log "Executing installed ${runtime_name} runtime."
    exec "${runtime_binary}" "$@"
}

[ -n "${RUNTIME_SHIM_PATH:-}" ] || runtime_error "RUNTIME_SHIM_PATH was not provided by the desktop wrapper."
RUNTIME_SHIM_CANONICAL="$(runtime_canonicalize_existing_path "${RUNTIME_SHIM_PATH}")" || runtime_error "The desktop runtime shim path could not be resolved."
RUNTIME_SHIM_DIRECTORY="$(dirname "${RUNTIME_SHIM_CANONICAL}")"
RUNTIME_SAFE_PATH="$(runtime_path_without_shim)"
