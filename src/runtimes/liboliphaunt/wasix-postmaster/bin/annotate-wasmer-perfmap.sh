#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
  cat >&2 <<EOF
Usage: $0 PERF_MAP WASM_NM_OR_FUNCTION_MAP OUTPUT_PERF_MAP

Rewrites Wasmer perfmap symbols like module_HASH::function_N with names from a
Binaryen wasm-opt --nm listing or --print-function-map output for the
corresponding module. The rewritten perfmap keeps addresses and extents
unchanged, so it can be passed to symbolize-wasmer-sample.sh.
EOF
  exit 2
fi

perf_map="$1"
name_map="$2"
output="$3"

perl - "$perf_map" "$name_map" "$output" <<'PERL'
use strict;
use warnings;

my ($perf_map, $name_map, $output) = @ARGV;

open my $nm_fh, '<', $name_map or die "open $name_map: $!";
my @names;
my %index_names;
my $has_explicit_indexes = 0;
while (my $line = <$nm_fh>) {
    chomp $line;
    if ($line =~ /^\s*(\d+):(.*)$/) {
        my ($idx, $name) = ($1 + 0, $2);
        $name =~ s/^\s+|\s+$//g;
        next if $name eq '';
        $index_names{$idx} = $name;
        $has_explicit_indexes = 1;
        next;
    }
    if ($line =~ /^\s*(.*?)\s+:\s+[0-9a-fA-F]+\s*$/) {
        my $name = $1;
        $name =~ s/^\s+|\s+$//g;
        next if $name eq '';
        push @names, $name;
    }
}
close $nm_fh;
die "no function names parsed from $name_map\n"
    unless @names || %index_names;

open my $perf_fh, '<', $perf_map or die "open $perf_map: $!";
my @lines = <$perf_fh>;
close $perf_fh;

my %modules;
for my $line (@lines) {
    next unless $line =~ /^\S+\s+\S+\s+(\S+?::function_(\d+))(?:\+\S+)?\s*$/;
    my ($symbol, $idx) = ($1, $2 + 0);
    my ($module) = $symbol =~ /^(.*?)::function_\d+$/;
    my $m = ($modules{$module} ||= { count => 0, min => $idx, max => $idx });
    $m->{count}++;
    $m->{min} = $idx if $idx < $m->{min};
    $m->{max} = $idx if $idx > $m->{max};
}

my $target_module;
if (!$has_explicit_indexes) {
    for my $module (sort keys %modules) {
        my $m = $modules{$module};
        my $span = $m->{max} - $m->{min} + 1;
        if ($m->{count} == @names && $span == @names) {
            $target_module = $module;
            last;
        }
    }
}

if (!defined $target_module) {
    my @candidates = sort {
        $modules{$b}->{count} <=> $modules{$a}->{count}
            || $modules{$a}->{min} <=> $modules{$b}->{min}
    } grep {
        $has_explicit_indexes
            || ($modules{$_}->{count} <= @names
                && ($modules{$_}->{max} - $modules{$_}->{min} + 1) <= @names)
    } keys %modules;
    $target_module = $candidates[0] if @candidates;
}
die "could not match $name_map to any fallback module in $perf_map\n"
    unless defined $target_module;

my $base = $modules{$target_module}->{min};
open my $out_fh, '>', $output or die "open $output: $!";
my $rewritten = 0;
for my $line (@lines) {
    if ($line =~ /^(\S+\s+\S+\s+)\Q$target_module\E::function_(\d+)(\s*)$/) {
        my ($prefix, $idx, $suffix) = ($1, $2 + 0, $3);
        my $name;
        if ($has_explicit_indexes) {
            $name = $index_names{$idx};
        } else {
            my $local = $idx - $base;
            $name = $names[$local] if $local >= 0 && $local < @names;
        }
        if (defined $name) {
            $name =~ s/\s+/_/g;
            print {$out_fh} $prefix, $target_module, "::", $name, $suffix, "\n";
            $rewritten++;
            next;
        }
    }
    print {$out_fh} $line;
}
close $out_fh;

print STDERR "annotated module $target_module from function_$base with $rewritten names\n";
PERL
