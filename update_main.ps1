$file = 'C:\Users\beyza\Desktop\RingtoneMasterV2\app\src\main\java\com\example\ringtonemasterv2\MainActivity.kt'
$text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# 1. ADD CACHE VARIABLE
if ($text -notmatch 'private var cachedTop50Results') {
    $text = $text -replace '(private val searchResults = mutableListOf<VideoModel>\(\))', "$1
    private var cachedTop50Results = mutableListOf<VideoModel>()"
}

# 2. MODIFY fetchTop50() to use cache
$fetchTop50Original = '    private fun fetchTop50\(\) \{

        val url = "https://ringtone-production\.up\.railway\.app/top50"
        txtToolbarTitle\.text = "Home"
        txtToolbarSubtitle\.text = "Popular"
        loadingLayout\.visibility = View\.VISIBLE'

$fetchTop50New = '    private fun fetchTop50() {

        val url = "https://ringtone-production.up.railway.app/top50"
        txtToolbarTitle.text = "Home"
        txtToolbarSubtitle.text = "Popular"
        
        // ÖN BELLEK KONTROLÜ
        if (cachedTop50Results.isNotEmpty()) {
            recyclerView.layoutManager = androidx.recyclerview.widget.GridLayoutManager(this@MainActivity, 2)
            recyclerView.adapter = HomeAdapter(
                cachedTop50Results,
                onWatch = { video -> startActivity(Intent(this@MainActivity, VideoPlayerActivity::class.java).putExtra("url", video.url)) },
                onListen = { video ->
                    val trackList = cachedTop50Results.map {
                        TrackEntity(playlistId = -1, title = it.title, uploader = it.uploader, streamUrl = it.url, thumbnailUrl = it.thumbnailUrl)
                    }
                    val track = trackList.find { it.streamUrl == video.url }
                    if (track != null) playTrack(track, trackList)
                },
                onDownloadMp3 = { downloadFile(it, "_audio.m4a") },
                onDownloadMp4 = { downloadFile(it, "_video.mp4") },
                onAddPlaylist = { showPlaylistPicker(it) },
                onGoDownloads = { refreshDownloadsList() }
            )
            return
        }

        loadingLayout.visibility = View.VISIBLE'

$text = $text -replace $fetchTop50Original, $fetchTop50New

# 3. SAVE to cache when fetch finishes
$saveCacheOriginal = '                    //  HOME = 2''li Grid
                    recyclerView\.layoutManager =
                        androidx\.recyclerview\.widget\.GridLayoutManager\(this@MainActivity, 2\)

                    android\.util\.Log\.d\("TOP50_SOURCE", "Top50 \''den geldi"\)'

$saveCacheNew = '                    //  HOME = 2''li Grid
                    recyclerView.layoutManager =
                        androidx.recyclerview.widget.GridLayoutManager(this@MainActivity, 2)

                    android.util.Log.d("TOP50_SOURCE", "Top50 ''den geldi")
                    
                    cachedTop50Results.clear()
                    cachedTop50Results.addAll(results)'

$text = $text -replace $saveCacheOriginal, $saveCacheNew

# 4. FIX SEARCH (NULL SAFETY)
$searchOriginal = 'for \(i in 0 until items\.length\(\)\) \{

                    val item = items\.getJSONObject\(i\)
                    val snippet = item\.getJSONObject\("snippet"\)

                    // id hem string hem object olabilir
                    val videoId = if \(item\.get\("id"\) is String\) \{
                        item\.getString\("id"\)
                    \} else \{
                        item\.getJSONObject\("id"\)\.getString\("videoId"\)
                    \}

                    val title = snippet\.getString\("title"\)
                    val channel = snippet\.getString\("channelTitle"\)

                    val thumbnail = snippet
                        \.getJSONObject\("thumbnails"\)
                        \.getJSONObject\("high"\)
                        \.getString\("url"\)

                    searchResults\.add\(
                        VideoModel\(
                            title = title,
                            uploader = channel,
                            url = "https://www\.youtube\.com/watch\?v=\",
                            thumbnailUrl = thumbnail,
                            duration = 0L
                        \)
                    \)
                \}'

$searchNew = 'for (i in 0 until items.length()) {
                    try {
                        val item = items.getJSONObject(i)
                        val snippet = item.optJSONObject("snippet") ?: continue

                        // id hem string hem object olabilir
                        val videoId = if (item.has("id") && item.get("id") is String) {
                            item.getString("id")
                        } else if (item.has("id")) {
                            item.getJSONObject("id").optString("videoId", "")
                        } else {
                            ""
                        }
                        if (videoId.isEmpty()) continue

                        val title = snippet.optString("title", "Unknown")
                        val channel = snippet.optString("channelTitle", "Unknown")

                        val thumbs = snippet.optJSONObject("thumbnails")
                        val thumbnail = thumbs?.optJSONObject("high")?.optString("url")
                            ?: thumbs?.optJSONObject("medium")?.optString("url")
                            ?: thumbs?.optJSONObject("default")?.optString("url")
                            ?: "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"

                        searchResults.add(
                            VideoModel(
                                title = title,
                                uploader = channel,
                                url = "https://www.youtube.com/watch?v=$videoId",
                                thumbnailUrl = thumbnail,
                                duration = 0L
                            )
                        )
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }'

$text = $text -replace $searchOriginal, $searchNew

[System.IO.File]::WriteAllText($file, $text, [System.Text.Encoding]::UTF8)