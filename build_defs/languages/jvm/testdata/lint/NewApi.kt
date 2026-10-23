package dev.oliphaunt.lintfixture

import android.graphics.Color

/** API 26 cannot be called unguarded by this fixture's API 24 contract. */
fun unsupportedApi(): Color = Color.valueOf(0)
