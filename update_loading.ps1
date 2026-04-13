$file = 'C:\Users\beyza\Desktop\RingtoneMasterV2\app\src\main\java\com\example\ringtonemasterv2\MainActivity.kt'
$text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# FIND THE SEARCH BLOCK TO ADD LOADING UI
$searchStartOrig = '    private fun performSearch(query: String) {
        txtToolbarTitle.text = "Search Results"
        txtToolbarSubtitle.text = query
        currentQuery = query
        searchResults.clear()

        lifecycleScope.launch(Dispatchers.IO) {'

$searchStartNew = '    private fun performSearch(query: String) {
        txtToolbarTitle.text = "Search Results"
        txtToolbarSubtitle.text = query
        currentQuery = query
        searchResults.clear()

        runOnUiThread {
            loadingLayout.visibility = View.VISIBLE
            recyclerView.adapter = null
        }

        lifecycleScope.launch(Dispatchers.IO) {'

$text = $text -replace [regex]::Escape($searchStartOrig), $searchStartNew

# FIND THE TRY-CATCH BLOCK END IN SEARCH TO ADD FINALLY
$searchEndOrig = '                                }
                            }
                        }
                    })

                    android.util.Log.d("SEARCH_RESULTS", "Results = ")'

$searchEndNew = '                                }
                            }
                        }
                    })

                    loadingLayout.visibility = View.GONE
                    if (searchResults.isEmpty()) {
                        Toast.makeText(this@MainActivity, "No results found or timed out", Toast.LENGTH_SHORT).show()
                    }

                    android.util.Log.d("SEARCH_RESULTS", "Results = ")'

$text = $text -replace [regex]::Escape($searchEndOrig), $searchEndNew

# Add finally logic in case of early return@launch
$searchReturn1 = '                val body = response.body()?.string() ?: return@launch'
$searchReturn1New = '                val body = response.body()?.string() ?: {
                    withContext(Dispatchers.Main) { loadingLayout.visibility = View.GONE }
                    return@launch
                }()'
$text = $text -replace [regex]::Escape($searchReturn1), $searchReturn1New

$searchCatchOrig = '            } catch (e: Exception) {
                e.printStackTrace()
                withContext(Dispatchers.Main) {
                    loadingLayout.visibility = View.GONE
                }
            }'

# Just in case there is no catch handler with loading, we add it back... Wait, the file currently just has catch (e: Exception) { e.printStackTrace() }
$searchCatchCurrent = '            } catch (e: Exception) {
                e.printStackTrace()
            }
        }'
$searchCatchNew = '            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                withContext(Dispatchers.Main) { loadingLayout.visibility = View.GONE }
            }
        }'
$text = $text -replace [regex]::Escape($searchCatchCurrent), $searchCatchNew

[System.IO.File]::WriteAllText($file, $text, [System.Text.Encoding]::UTF8)