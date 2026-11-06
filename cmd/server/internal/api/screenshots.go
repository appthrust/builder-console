package api

import (
	"github.com/appthrust/appserver-go/appserver/httpx"
	"io"
	"net/http"

	"github.com/appthrust/builder-console/cmd/server/internal/domain"
)

func (a *API) screenshot(s *request) (any, int, error) {
	app, err := s.boundApp()
	if err != nil {
		return nil, 0, err
	}
	data, contentType, err := s.tx.Screenshot(app.ID, s.r.PathValue("sid"))
	return rawBody{contentType: contentType, data: data, cacheControl: "private, max-age=86400"}, http.StatusOK, err
}

func (a *API) uploadScreenshot(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	s.r.Body = http.MaxBytesReader(s.w, s.r.Body, 3<<20)
	if err := s.r.ParseMultipartForm(3 << 20); err != nil {
		return nil, 0, httpx.Invalid("Request must be multipart/form-data within the size limit")
	}
	defer s.r.MultipartForm.RemoveAll()
	files := s.r.MultipartForm.File["file"]
	if len(files) != 1 {
		return nil, 0, httpx.Invalid("Exactly one file is required")
	}
	if files[0].Size > domain.MaxScreenshotBytes {
		return nil, 0, httpx.Invalid("Screenshot must be at most 2 MiB")
	}
	file, err := files[0].Open()
	if err != nil {
		return nil, 0, httpx.Invalid("Screenshot file could not be read")
	}
	defer file.Close()
	data := make([]byte, int(files[0].Size))
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, 0, httpx.Invalid("Screenshot file could not be read")
	}
	// Read only multipart fields; a query parameter must not supply the caption.
	caption := ""
	if values := s.r.MultipartForm.Value["caption"]; len(values) > 0 {
		caption = values[0]
	}
	screenshot, err := s.tx.AddScreenshot(app.ID, s.person.ID, data, caption)
	return screenshot, http.StatusCreated, err
}

func (a *API) deleteScreenshot(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	return nil, http.StatusNoContent, s.tx.DeleteScreenshot(app.ID, s.r.PathValue("sid"))
}

func (a *API) reorderScreenshots(s *request) (any, int, error) {
	app, err := s.editableApp()
	if err != nil {
		return nil, 0, err
	}
	var input struct {
		Order []string `json:"order"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	screenshots, err := s.tx.ReorderScreenshots(app.ID, input.Order)
	return screenshots, http.StatusOK, err
}
