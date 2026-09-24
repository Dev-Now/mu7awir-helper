## High level purpose of the app

As a محاور, I want to be able to open side by side the social media page and this app to search for relevant information from various sources (Primarily for Daawah دعوة, but should work for any domain with configuration: Quran, Hadith, Fiqh, Fatwa, etc.) and draft responses efficiently (quick and smooth experience with clipboard = copy / paste from sources + navigation + dictation). The app should provide a streamlined interface for searching, organizing discussions, and drafting responses.

## الأدوات

- الباحث القرآني : tafsir.app
- الباحث الحديثي : sunnah.one
- (باحث في مدونة الفقه المالكي) - ؟ still cannot find a searchable reliable website.
- فتاوى إسلام سؤال وجواب : https://islamqa.info/ar
- (باحث في مكتبة الردود) : أصنعه أنا من مكتبة ردود التلغرام - from chat channel history exported here: `D:\Programming\mu7awir-helper\doc\ChatExport_2026-09-24__JSON\`
- بصائر : basaer.shuounislamiya.org
- المكتبة الشاملة : https://shamela.ws/

** أداة الإملاء الصوتي

**Note**: search tools are configurable plugins that can be added or removed. ones above are the defaults.

## الاستخدام

- Copy buttons everywhere + copy shortcut
- Tree representation of discussion in data models:
    - discussion
        - 0..* search(es) of any kind of pre-configured search tools (quran, hadith, fiqh, fatwa, rad, basaer, etc.)
        - 0..* response draft(s)
- Keyboard shortcuts:
	- new discussion (name it)
	- new search (inside discussion) - pre-configured keyboard shortcuts for each search tool (quran, hadith, fiqh, fatwa, rad, basaer, etc.)
	- new response draft (inside discussion)
		- Invoke ar dictation tool (inside response draft)
	- move to next discussion (similar to tab navigation in browsers)
	- move to prev discussion (similar to tab navigation in browsers)
	- move to next search tab (in discussion)
	- move to prev search tab (in discussion)
    - jump to first search tab (in discussion)
    - jump to last search tab (in discussion)
    - move to next response draft tab (in discussion)
    - move to prev response draft tab (in discussion)
    - jump to first response draft tab (in discussion)
    - jump to last response draft tab (in discussion)
	- rename discussion
	- rename tab - search or response draft (in discussion)
- autosave
- archive / delete

## الواجهة

Similar to a browser customized for the tasks of a محاور.

- Left side bar (expandable) = discussions
- Top bar = tabs of selected discussion (quran search 1, hadith search 2, response draft 3, response draft 4, etc.) OR (make this configurable) we can have a split view of search tabs 2/3 and response draft tabs 1/3 (like in VSCode)
- main view = shows selected tab of selected discussion:
	- a view of the web page like it would render on normal browser (might want to simplify render to mostly text for performance and easy select+copy ... but search and nav functionality should still be functional)
        - I don't know if it is possible to inject copy buttons into the web page view, but if possible, it would be nice to have a copy button for each paragraph or section of the page.
	- except reponse draft view = an editor view specific to the app, content being composed shows RTL (user pastes in what he copied from search tools, dictates in ar vocal, or types manually. He can also copy the whole response.)