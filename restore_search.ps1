$file = 'C:\Users\beyza\Desktop\RingtoneMasterV2\app\src\main\java\com\example\ringtonemasterv2\MainActivity.kt'
$text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# RESTORE performSearch entirely from the corrupted state to the original one
$performSearchPattern = '    private fun performSearch\([^\{]*\{[\s\S]*?(?=\s*// DOWNLOADS KISMI)'

$originalPerformSearch = '    private fun performSearch(query: String) {
        txtToolbarTitle.text = "Search Results"
        txtToolbarSubtitle.text = query
        currentQuery = query
        searchResults.clear()

        lifecycleScope.launch(Dispatchers.IO) {
            try {

                val url = "${ApiConfig.BASE_URL}/search?q=${java.net.URLEncoder.encode(query, "UTF-8")}"
                val requestBuilder = Request.Builder().url(url)
                val request = ApiSecurity.signRequest(requestBuilder, url).build()


                val response = httpClient.newCall(request).execute()


                //  403 kontrolü
                if (response.code() == 403) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(
                            this@MainActivity,
                            "Unauthorized request",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    return@launch
                }

                // 429 kontrolü
                if (response.code() == 429) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(
                            this@MainActivity,
                            "Too many searches. Please wait 1 minute.",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    return@launch
                }

                val body = response.body()?.string() ?: return@launch

                val jsonObject = org.json.JSONObject(body)
                nextPageToken = jsonObject.optString("nextPageToken", null)
                val items = jsonObject.getJSONArray("data")


                for (i in 0 until items.length()) {

                    val item = items.getJSONObject(i)
                    val snippet = item.getJSONObject("snippet")

                    // id hem string hem object olabilir
                    val videoId = if (item.get("id") is String) {
                        item.getString("id")
                    } else {
                        item.getJSONObject("id").getString("videoId")
                    }

                    val title = snippet.getString("title")
                    val channel = snippet.getString("channelTitle")

                    val thumbnail = snippet
                        .getJSONObject("thumbnails")
                        .getJSONObject("high")
                        .getString("url")

                    searchResults.add(
                        VideoModel(
                            title = title,
                            uploader = channel,
                            url = "https://www.youtube.com/watch?v=$videoId",
                            thumbnailUrl = thumbnail,
                            duration = 0L
                        )
                    )
                }

                withContext(Dispatchers.Main) {

                    recyclerView.layoutManager = LinearLayoutManager(this@MainActivity)

                    // ÇÖZÜM BURADA: Eski dinleyicileri temizle Memory Leak''i önle!
                    recyclerView.clearOnScrollListeners()

                    recyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {

                        override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {

                            if (dy <= 0) return

                            val layoutManager = rv.layoutManager as LinearLayoutManager
                            val lastVisible = layoutManager.findLastVisibleItemPosition()

                            if (!isLoadingMore && lastVisible >= searchResults.size - 5) {

                                if (nextPageToken != null) {

                                    loadNextPage()

                                }
                            }
                        }
                    })

                    android.util.Log.d("SEARCH_RESULTS", "Results = ${searchResults.size}")

                    val trackList = searchResults.map {
                        TrackEntity(
                            playlistId = -1,
                            title = it.title,
                            uploader = it.uploader,
                            streamUrl = it.url,
                            thumbnailUrl = it.thumbnailUrl
                        )
                    }
                    recyclerView.adapter = SearchAdapter(
                        searchResults,

                        onWatch = { video ->
                            val intent = Intent(this@MainActivity, VideoPlayerActivity::class.java)
                            intent.putExtra("url", video.url)
                            startActivity(intent)
                        },

                        onListen = { video ->
                            val track = trackList.find { it.streamUrl == video.url }
                            if (track != null) {
                                playTrack(track, trackList)
                            }
                        },

                        onDownloadMp3 = { video ->
                            downloadFile(video, "_audio.m4a")
                        },

                        onDownloadMp4 = { video ->
                            downloadFile(video, "_video.mp4")
                        },

                        onAddPlaylist = { video ->
                            showPlaylistPicker(video)
                        },

                        onGoDownloads = {
                            refreshDownloadsList()
                        }
                    )
                }

            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }'

$text = [System.Text.RegularExpressions.Regex]::Replace($text, $performSearchPattern, $originalPerformSearch)


# RESTORE onQueryTextChange
$onQueryPattern = '                override fun onQueryTextChange\(newText: String\?\): Boolean \{[\s\S]*?(?=                override fun onQueryTextSubmit)'

$originalOnQuery = '                override fun onQueryTextChange(newText: String?): Boolean {

                    if (!newText.isNullOrEmpty()) {

                        // FULL SCREEN SEARCH MOD !

                        downloadTabs.visibility = View.GONE
                        miniPlayer.visibility = View.GONE
                        downloadBar.visibility = View.GONE

                        fetchSuggestions(newText) { suggestions ->
                            recyclerView.layoutManager =
                                LinearLayoutManager(this@MainActivity)

                            recyclerView.adapter = SuggestionsAdapter(
                                suggestions,
                                onClick = { selected ->
                                    searchView.setQuery(selected, true) // tıklayınca arama yapsın
                                    performSearch(selected) // OTOMATİK ARA
                                    searchView.clearFocus() 
                                },
                                onArrowClick = { selected ->
                                    searchView.setQuery(selected, false) // sadece yazsın arama yapmasın
                                }
                            )
                        }

                    } else {

                        // arama silinince normale dön
                        fetchTop50()
                        updateMiniPlayerVisibility()
                        downloadBar.visibility = View.VISIBLE
                    }

                    return true
                }
'

$text = [System.Text.RegularExpressions.Regex]::Replace($text, '                override fun onQueryTextChange\(newText: String\?\): Boolean \{[\s\S]*?\}\s*\}\s*\)\s*\}\s*return true\s*\}', $originalOnQuery + "
            })
        }

        return true
    }")


[System.IO.File]::WriteAllText($file, $text, [System.Text.Encoding]::UTF8)