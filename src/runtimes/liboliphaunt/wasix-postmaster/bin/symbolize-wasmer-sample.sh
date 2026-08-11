#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 SAMPLE_TXT PERF_MAP OUTPUT_PREFIX

Maps raw JIT addresses in a macOS sample(1) report through a Wasmer
--profiler perfmap file.

Outputs:
  OUTPUT_PREFIX.txt      sample report with address annotations
  OUTPUT_PREFIX.top.tsv  top-of-stack sample counts grouped by perfmap symbol
EOF
}

if [ "$#" -ne 3 ]; then
  usage >&2
  exit 2
fi

sample_txt="$1"
perf_map="$2"
output_prefix="$3"

if [ ! -s "$sample_txt" ]; then
  echo "missing or empty sample report: $sample_txt" >&2
  exit 2
fi
if [ ! -s "$perf_map" ]; then
  echo "missing or empty perf map: $perf_map" >&2
  exit 2
fi

perl -Mstrict -Mwarnings -e '
  no warnings "portable";

  my ($sample_txt, $perf_map, $annotated_out, $top_out) = @ARGV;

  open my $perf_fh, "<", $perf_map or die "open $perf_map: $!";
  my @entries;
  while (my $line = <$perf_fh>) {
    chomp $line;
    next unless $line =~ /^0x([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(.+)$/;
    my $start = hex($1);
    my $size = hex($2);
    next if $size <= 0;
    push @entries, [$start, $start + $size, $size, $3];
  }
  close $perf_fh;
  @entries = sort { $a->[0] <=> $b->[0] } @entries;

  sub lookup_addr {
    my ($addr) = @_;
    my ($lo, $hi) = (0, scalar(@entries) - 1);
    while ($lo <= $hi) {
      my $mid = int(($lo + $hi) / 2);
      my $entry = $entries[$mid];
      if ($addr < $entry->[0]) {
        $hi = $mid - 1;
      } elsif ($addr >= $entry->[1]) {
        $lo = $mid + 1;
      } else {
        return ($entry->[3], $addr - $entry->[0], $entry->[2]);
      }
    }
    return;
  }

  open my $sample_fh, "<", $sample_txt or die "open $sample_txt: $!";
  open my $annotated_fh, ">", $annotated_out or die "open $annotated_out: $!";

  my %top_counts;
  my $in_top = 0;
  while (my $line = <$sample_fh>) {
    if ($line =~ /^Sort by top of stack/) {
      $in_top = 1;
    } elsif ($line =~ /^Binary Images:/) {
      $in_top = 0;
    }

    my @annotations;
    while ($line =~ /\[(0x[0-9a-fA-F]+)\]/g) {
      my $addr = hex($1);
      my @hit = lookup_addr($addr);
      next unless @hit;
      push @annotations, sprintf("%s=>%s+0x%x/0x%x", $1, $hit[0], $hit[1], $hit[2]);
    }
    if (@annotations) {
      chomp $line;
      print {$annotated_fh} $line, "    # ", join("; ", @annotations), "\n";
    } else {
      print {$annotated_fh} $line;
    }

    next unless $in_top;
    next unless $line =~ /\[(0x[0-9a-fA-F]+)\]\s+([0-9]+)\s*$/;
    my $addr = hex($1);
    my $count = $2 + 0;
    my @hit = lookup_addr($addr);
    next unless @hit;
    my $symbol = sprintf("%s+0x%x/0x%x", $hit[0], $hit[1], $hit[2]);
    $top_counts{$symbol} += $count;
  }
  close $sample_fh;
  close $annotated_fh;

  open my $top_fh, ">", $top_out or die "open $top_out: $!";
  print {$top_fh} "samples\tsymbol\n";
  for my $symbol (sort { $top_counts{$b} <=> $top_counts{$a} || $a cmp $b } keys %top_counts) {
    print {$top_fh} $top_counts{$symbol}, "\t", $symbol, "\n";
  }
  close $top_fh;
' "$sample_txt" "$perf_map" "$output_prefix.txt" "$output_prefix.top.tsv"

printf 'wrote %s and %s\n' "$output_prefix.txt" "$output_prefix.top.tsv"
