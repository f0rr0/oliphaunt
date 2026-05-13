#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: summarize-wasix-perf-stats.sh PERF_LOG [OUTPUT_PREFIX]

Extracts the last cumulative WASIX perf-stats snapshot from PERF_LOG and writes:
  OUTPUT_PREFIX.tsv          raw counters
  OUTPUT_PREFIX.top-time.tsv counters sorted by total_ns descending
  OUTPUT_PREFIX.top-bytes.tsv counters sorted by total_bytes descending
  OUTPUT_PREFIX.pwrite-paths.tsv          per-path fd_pwrite counters
  OUTPUT_PREFIX.pwrite-paths.top-time.tsv per-path fd_pwrite counters by time
  OUTPUT_PREFIX.pwrite-paths.top-bytes.tsv per-path fd_pwrite counters by bytes

The runtime must be built with the wasmer-wasix `perf-stats` feature and run
with WASIX_PERF_STATS=1. Set WASIX_PERF_STATS_FILE to choose PERF_LOG.
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi

perf_log="$1"
output_prefix="${2:-${perf_log%.log}}"

if [ ! -s "$perf_log" ]; then
  printf 'missing or empty perf log: %s\n' "$perf_log" >&2
  exit 2
fi

raw_tsv="$output_prefix.tsv"
top_time_tsv="$output_prefix.top-time.tsv"
top_bytes_tsv="$output_prefix.top-bytes.tsv"
pwrite_paths_tsv="$output_prefix.pwrite-paths.tsv"
pwrite_paths_top_time_tsv="$output_prefix.pwrite-paths.top-time.tsv"
pwrite_paths_top_bytes_tsv="$output_prefix.pwrite-paths.top-bytes.tsv"

perl -Mstrict -Mwarnings -e '
  my ($in, $raw, $pwrite_paths) = @ARGV;
  open my $fh, "<", $in or die "open $in: $!";
  my @current_stats;
  my @current_paths;
  my @last_stats;
  my @last_paths;
  my $inside = 0;
  while (my $line = <$fh>) {
    chomp $line;
    if ($line =~ /^wasix-perf-stats\tbegin\t/) {
      @current_stats = ();
      @current_paths = ();
      $inside = 1;
      next;
    }
    if ($line eq "wasix-perf-stats\tend") {
      if (@current_stats || @current_paths) {
        @last_stats = @current_stats;
        @last_paths = @current_paths;
      }
      $inside = 0;
      next;
    }
    next unless $inside;
    if ($line =~ /^wasix-perf-stat\t/) {
      next if $line =~ /^wasix-perf-stat\tname\t/;
      push @current_stats, $line;
      next;
    }
    if ($line =~ /^wasix-perf-pwrite-path\t/) {
      next if $line =~ /^wasix-perf-pwrite-path\tpath\t/;
      push @current_paths, $line;
      next;
    }
  }
  close $fh;
  die "no perf stat snapshot found in $in\n" unless @last_stats || @last_paths;

  open my $out, ">", $raw or die "open $raw: $!";
  print {$out} "name\tcalls\ttotal_ns\tmax_ns\tavg_ns\ttotal_bytes\tmax_bytes\tlast_bytes\n";
  for my $line (@last_stats) {
    $line =~ s/^wasix-perf-stat\t//;
    print {$out} "$line\n";
  }
  close $out;

  open my $paths_out, ">", $pwrite_paths or die "open $pwrite_paths: $!";
  print {$paths_out} "path\tcalls\ttotal_ns\tmax_ns\tavg_ns\ttotal_bytes\tmax_bytes\tlast_bytes\n";
  for my $line (@last_paths) {
    $line =~ s/^wasix-perf-pwrite-path\t//;
    print {$paths_out} "$line\n";
  }
  close $paths_out;
' "$perf_log" "$raw_tsv" "$pwrite_paths_tsv"

{
  head -n 1 "$raw_tsv"
  tail -n +2 "$raw_tsv" | sort -t $'\t' -k3,3nr
} >"$top_time_tsv"

{
  head -n 1 "$raw_tsv"
  tail -n +2 "$raw_tsv" | sort -t $'\t' -k6,6nr
} >"$top_bytes_tsv"

{
  head -n 1 "$pwrite_paths_tsv"
  tail -n +2 "$pwrite_paths_tsv" | sort -t $'\t' -k3,3nr
} >"$pwrite_paths_top_time_tsv"

{
  head -n 1 "$pwrite_paths_tsv"
  tail -n +2 "$pwrite_paths_tsv" | sort -t $'\t' -k6,6nr
} >"$pwrite_paths_top_bytes_tsv"

printf 'wrote %s, %s, %s, %s, %s, and %s\n' \
  "$raw_tsv" \
  "$top_time_tsv" \
  "$top_bytes_tsv" \
  "$pwrite_paths_tsv" \
  "$pwrite_paths_top_time_tsv" \
  "$pwrite_paths_top_bytes_tsv"
